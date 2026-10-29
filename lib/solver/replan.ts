import type { BookingAction, Disruption, Placement, Plan, Remedy, ReplanOptions, Session, State } from "../domain/types";
import { DisruptionSchema, ReplanOptionsSchema } from "../domain/schemas";
import { addLocalDays, byId, compare, DAY, iso, localParts, MINUTE, zonedTimeToUtc } from "../domain/time";
import { bookingActionEvaluator, calculateTotals, compareObjectives, defaultWeights, isActiveBooking, remedyPriority, scoreCandidate, SLOT_MS, type CandidateObjective } from "./score";
import { affectedSessions } from "./validate";
import { activeConstraints } from "./constraints";

export { applyPlan } from "./validate";

/** Placements the exact pass may evaluate before keeping its best plan so far (deterministic, about a second). */
const WORK_BUDGET = 250_000;
/** Equally good placements per class the exact pass branches on, closest to the original first. */
const MAX_TIED_OPTIONS = 24;

const placement = (session: Session): Placement => ({
  instructorId: session.instructorId, roomId: session.roomId, start: session.start, end: session.end,
});
type Candidate = { remedy: Remedy; after?: Session; actions: BookingAction[]; objective: CandidateObjective };
const reasons: Record<Remedy, string> = {
  substitute: "Qualified substitute keeps the class at its original time.",
  move_room: "Suitable replacement room keeps the class at its original time.",
  move_time: "Class rescheduled to an available slot within the recovery horizon.",
  cancel: "No feasible class within the recovery horizon; cancel and refund.",
};

/** Working resources stay fixed during each class's search; index their numeric intervals once. */
function candidateFeasibility(state: State, before: Session, disruption: Disruption): (candidate: Session) => boolean {
  type Interval = { start: number; end: number };
  const instructorBusy = new Map<string, Interval[]>();
  const roomBusy = new Map<string, Interval[]>();
  const daily = new Map<string, number>();
  const add = (index: Map<string, Interval[]>, id: string, interval: Interval) => {
    const entries = index.get(id) ?? [];
    entries.push(interval); index.set(id, entries);
  };
  for (const session of state.sessions) {
    if (session.id === before.id) continue;
    const interval = { start: Date.parse(session.start), end: Date.parse(session.end) };
    add(instructorBusy, session.instructorId, interval);
    add(roomBusy, session.roomId, interval);
    const key = `${session.instructorId}|${localParts(session.start, state.studio.timezone).dateKey}`;
    daily.set(key, (daily.get(key) ?? 0) + 1);
  }
  for (const instructor of state.instructors) {
    for (const window of instructor.unavailability ?? []) {
      add(instructorBusy, instructor.id, { start: Date.parse(window.from), end: Date.parse(window.to) });
    }
  }
  const closures: Interval[] = [];
  for (const constraint of [...activeConstraints(state), disruption]) {
    const interval = { start: Date.parse(constraint.from), end: Date.parse(constraint.to) };
    if (constraint.kind === "closure") closures.push(interval);
    else if (constraint.kind === "instructor_unavailable") add(instructorBusy, constraint.instructorId, interval);
    else add(roomBusy, constraint.roomId, interval);
  }
  const instructors = new Map(state.instructors.filter((item) => item.skills.includes(before.classType)).map((item) => [item.id, item]));
  const rooms = new Map(state.rooms.filter((item) => item.supports.includes(before.classType)).map((item) => [item.id, item]));
  const times = new Map<string, { start: number; end: number; date: string; open: boolean }>();
  const availableInstructors = new Map<string, boolean>();
  const availableRooms = new Map<string, boolean>();
  return (candidate) => {
    const timeKey = `${candidate.start}|${candidate.end}`;
    let time = times.get(timeKey);
    if (!time) {
      const start = Date.parse(candidate.start), end = Date.parse(candidate.end);
      const { dateKey, weekday } = localParts(candidate.start, state.studio.timezone);
      time = { start, end, date: dateKey, open: end > start &&
        !closures.some((item) => start < item.end && item.start < end) &&
        (state.studio.openHours[weekday] ?? []).some((hours) =>
          start >= Date.parse(zonedTimeToUtc(dateKey, hours.open, state.studio.timezone)) &&
          end <= Date.parse(zonedTimeToUtc(dateKey, hours.close, state.studio.timezone))) };
      times.set(timeKey, time);
    }
    if (!time.open) return false;
    const instructor = instructors.get(candidate.instructorId), room = rooms.get(candidate.roomId);
    if (!instructor || !room || candidate.capacity > room.capacity) return false;
    const instructorKey = `${timeKey}|${instructor.id}`, roomKey = `${timeKey}|${room.id}`;
    let instructorFree = availableInstructors.get(instructorKey);
    if (instructorFree === undefined) {
      instructorFree = (daily.get(`${instructor.id}|${time.date}`) ?? 0) < instructor.maxSessionsPerDay &&
        !(instructorBusy.get(instructor.id) ?? []).some((item) => time.start < item.end && item.start < time.end);
      availableInstructors.set(instructorKey, instructorFree);
    }
    if (!instructorFree) return false;
    let roomFree = availableRooms.get(roomKey);
    if (roomFree === undefined) {
      roomFree = !(roomBusy.get(room.id) ?? []).some((item) => time.start < item.end && item.start < time.end);
      availableRooms.set(roomKey, roomFree);
    }
    return roomFree;
  };
}

/**
 * Deterministic. A greedy pass in session-ID order reserves each class's best placement; when its refunds exceed
 * the per-class lower bound, a budgeted branch and bound over placements finds a plan with fewer refunds if one exists.
 * Default horizon ends at now + 7 days; horizonEnd supplies an exact exclusive boundary.
 * Moves never precede the original session, and must finish inside the horizon.
 * If now is omitted, the earliest session start is used (or disruption.from for an empty state).
 * Move-time slots use a 15-minute grid plus original times and resource/opening boundaries.
 * Fewest refunds wins, then original time, then the same local time tomorrow,
 * then configured distance/cost. Ties use start, instructor ID, room ID and remedy.
 */
export function replan(state: State, disruption: Disruption, options: ReplanOptions = {}): Plan {
  DisruptionSchema.parse(disruption);
  ReplanOptionsSchema.parse(options);
  const now = iso(options.now ?? state.sessions.reduce((earliest, session) =>
    Date.parse(session.start) < Date.parse(earliest) ? session.start : earliest,
  state.sessions[0]?.start ?? disruption.from));
  const horizon = options.horizonEnd ? Date.parse(options.horizonEnd) : Date.parse(now) + (options.horizonDays ?? 7) * DAY;
  const tz = state.studio.timezone;
  const weights = { ...defaultWeights, ...options.weights };
  const affected = affectedSessions(state, disruption, now);
  const affectedIds = new Set(affected.map((session) => session.id));
  const working: State = { ...state, sessions: state.sessions.filter((session) => !affectedIds.has(session.id)),
    bookings: state.bookings.filter((booking) => !affectedIds.has(booking.sessionId)) };
  const instructors = [...state.instructors].sort(byId);
  const rooms = [...state.rooms].sort(byId);
  // Every customer's boundaries remain search candidates, but repeated windows add no slots.
  const preferenceWindows = [...new Map(state.customers.flatMap((customer) => customer.prefs.windows)
    .map((window) => [`${window.weekday}|${window.from}|${window.to}`, window])).values()];
  const plan: Plan = {
    disruption: structuredClone(disruption), now, sessionChanges: [], bookingActions: [],
    totals: calculateTotals(0, []), warnings: [],
  };
  let work = 0;
  /** Best placement for one class against `working`. With `all`, also collects every feasible placement (no pruning). */
  const search = (session: Session, working: State, all?: Candidate[]): Candidate => {
    const bookings = state.bookings.filter((booking) => booking.sessionId === session.id);
    const feasible = candidateFeasibility(working, session, disruption);
    const actionsAt = bookingActionEvaluator(bookings, state.customers, session, tz, { ...working, originalSessions: state.sessions });
    const unavoidableRefunds = bookings.filter(isActiveBooking).filter((booking) => {
      const customer = state.customers.find((item) => item.id === booking.customerId);
      return !customer || customer.prefs.refundOnly;
    }).length;
    const objective = (remedy: Remedy, after: Session | undefined, actions: BookingAction[]): CandidateObjective => ({
      refunds: actions.filter((action) => action.action === "refund").length,
      priority: remedyPriority(remedy, session, after, tz),
      cost: scoreCandidate(remedy, session, after, actions, weights, tz),
      key: after ? `${after.start}|${after.instructorId}|${after.roomId}|${remedy}` : "~cancel",
    });
    const cancelledActions = actionsAt(undefined);
    let best: Candidate = {
      remedy: "cancel", actions: cancelledActions,
      objective: objective("cancel", undefined, cancelledActions),
    };
    all?.push(best);
    const consider = (remedy: Remedy, candidate: Session) => {
      if (!feasible(candidate)) return;
      const actions = actionsAt(candidate);
      const candidateObjective = objective(remedy, candidate, actions);
      if (all) { work += 1; all.push({ remedy, after: candidate, actions, objective: candidateObjective }); }
      if (compareObjectives(candidateObjective, best.objective) < 0) {
        best = { remedy, after: candidate, actions, objective: candidateObjective };
      }
    };
    const considerMoves = (start: number, duration: number) => {
      const candidate = { ...session, start: iso(start), end: iso(start + duration) };
      // Original instructor and full capacity give a retention upper bound for this time.
      // A room or substitute can only add refunds. Keep the strict objective's tie order.
      const timeActions = actionsAt(candidate);
      const timeObjective = objective("move_time", candidate, timeActions);
      if (!all && (timeObjective.refunds > best.objective.refunds ||
        (timeObjective.refunds === best.objective.refunds && timeObjective.priority > best.objective.priority))) return;
      for (const instructor of instructors) {
        if (!instructor.skills.includes(session.classType)) continue;
        const withInstructor = { ...candidate, instructorId: instructor.id };
        const bound = objective("move_time", withInstructor, actionsAt(withInstructor));
        // The prefix sorts before every complete room key, including prefix-sharing room IDs.
        bound.key = `${withInstructor.start}|${instructor.id}|`;
        if (!all && compareObjectives(bound, best.objective) >= 0) continue;
        for (const room of rooms) {
          if (!room.supports.includes(session.classType)) continue;
          consider("move_time", { ...withInstructor, roomId: room.id, capacity: Math.min(session.capacity, room.capacity) });
        }
      }
    };
    for (const instructor of instructors) {
      if (instructor.id !== session.instructorId) consider("substitute", { ...session, instructorId: instructor.id });
    }
    if (disruption.kind === "room_unavailable") {
      for (const room of rooms) {
        if (room.id !== session.roomId) consider("move_room", { ...session, roomId: room.id, capacity: Math.min(session.capacity, room.capacity) });
      }
    }
    // Only skip moves when the retention upper bound is met at the original time.
    if (all || best.objective.refunds > unavoidableRefunds || best.objective.priority >= 2) {
      const duration = Date.parse(session.end) - Date.parse(session.start);
      const original = localParts(session.start, tz);
      const originalClock = original.minutesOfDay;
      const originalTime = `${String(Math.floor(originalClock / 60)).padStart(2, "0")}:${String(Math.floor(originalClock % 60)).padStart(2, "0")}`;
      const nextDayStart = Date.parse(zonedTimeToUtc(addLocalDays(original.dateKey, 1), originalTime, tz)) + (originalClock % 1) * MINUTE;
      // Evaluate the policy's preferred move first. Reaching the retention upper
      // bound here proves that no other move can improve this session's objective.
      if (nextDayStart >= Date.parse(now) && nextDayStart + duration <= horizon) {
        considerMoves(nextDayStart, duration);
      }
      if (all || best.objective.refunds > unavoidableRefunds || best.objective.priority > 2) {
        const boundaryTimes = [Date.parse(disruption.to),
          ...working.sessions.flatMap((item) => [Date.parse(item.end), Date.parse(item.start) - duration]),
          ...instructors.flatMap((instructor) => (instructor.unavailability ?? []).map((window) => Date.parse(window.to)))];
        const earliest = Math.max(Date.parse(now), Date.parse(session.start));
        for (let dateKey = localParts(iso(earliest), tz).dateKey;
          Date.parse(zonedTimeToUtc(dateKey, "00:00", tz)) < horizon; dateKey = addLocalDays(dateKey, 1)) {
          const day = Date.parse(zonedTimeToUtc(dateKey, "00:00", tz));
          const dayOfWeek = localParts(iso(day), tz).weekday;
          const hours = state.studio.openHours[dayOfWeek] ?? [];
          for (const window of hours) {
            const open = Math.max(Date.parse(zonedTimeToUtc(dateKey, window.open, tz)), earliest);
            const last = Math.min(Date.parse(zonedTimeToUtc(dateKey, window.close, tz)), horizon) - duration;
            const slots = new Set<number>([open, Date.parse(zonedTimeToUtc(dateKey, originalTime, tz)) + (originalClock % 1) * MINUTE]);
            for (let start = day + Math.ceil((open - day) / SLOT_MS) * SLOT_MS; start <= last; start += SLOT_MS) slots.add(start);
            for (const boundary of boundaryTimes) if (boundary >= open && boundary <= last) slots.add(boundary);
            for (const preference of preferenceWindows) {
              if (preference.weekday !== dayOfWeek) continue;
              slots.add(Date.parse(zonedTimeToUtc(dateKey, preference.from, tz)));
              slots.add(Date.parse(zonedTimeToUtc(dateKey, preference.to, tz)) - duration);
            }
            for (const start of [...slots].filter((slot) => slot >= open && slot <= last).sort((a, b) => a - b)) {
              if (start === Date.parse(session.start)) continue;
              considerMoves(start, duration);
            }
          }
        }
      }
    }
    return best;
  };
  type Step = { session: Session; best: Candidate };
  const place = (working: State, session: Session, best: Candidate): State => {
    if (!best.after) return working;
    const kept = state.bookings.filter((booking) => booking.sessionId === session.id &&
      best.actions.some((action) => action.bookingId === booking.id && action.action !== "refund"));
    return { ...working, sessions: [...working.sessions, best.after], bookings: [...working.bookings, ...kept] };
  };
  const refundsOf = (steps: Step[]) => steps.reduce((sum, step) => sum + step.best.objective.refunds, 0);
  // Greedy pass in session-ID order: each class takes its best placement and reserves its resources.
  let chosen: Step[] = [];
  let greedyWorking = working;
  for (const session of affected) {
    const best = search(session, greedyWorking);
    chosen.push({ session, best }); greedyWorking = place(greedyWorking, session, best);
  }
  // A class can never do better than with every other recovery out of its way: a sound lower bound.
  const alone = affected.map((session) => search(session, working).objective.refunds);
  const suffix = alone.map((_, index) => alone.slice(index).reduce((sum, value) => sum + value, 0));
  if (refundsOf(chosen) > (suffix[0] ?? 0)) {
    // Greedy order gave a shared resource (an instructor, a room, a time) to the wrong class. Branch and bound
    // over each class's alternatives: every placement with its fewest refunds (closest first) plus each
    // instructor's best, fewest refunds first, under a fixed work budget so results stay deterministic.
    let bestRefunds = refundsOf(chosen), found: Step[] | undefined;
    const visit = (depth: number, current: State, path: Step[], refunds: number) => {
      if (depth === affected.length) { bestRefunds = refunds; found = path; return; }
      const session = affected[depth];
      const all: Candidate[] = [];
      search(session, current, all);
      const byObjective = (x: Candidate, y: Candidate) => compareObjectives(x.objective, y.objective);
      const fewest = Math.min(...all.map((option) => option.objective.refunds));
      const options = new Map<string, Candidate>();
      for (const option of all.filter((item) => item.objective.refunds === fewest).sort(byObjective).slice(0, MAX_TIED_OPTIONS)) options.set(option.objective.key, option);
      const perInstructor = new Map<string, Candidate>();
      for (const option of all) {
        const id = option.after?.instructorId ?? "~cancel", previous = perInstructor.get(id);
        if (!previous || byObjective(option, previous) < 0) perInstructor.set(id, option);
      }
      for (const option of perInstructor.values()) options.set(option.objective.key, option);
      for (const option of [...options.values()].sort(byObjective)) {
        if (work > WORK_BUDGET) return;
        if (refunds + option.objective.refunds + (suffix[depth + 1] ?? 0) >= bestRefunds) break;
        visit(depth + 1, place(current, session, option), [...path, { session, best: option }], refunds + option.objective.refunds);
        if (bestRefunds === suffix[0]) return;
      }
    };
    visit(0, working, [], 0);
    if (found) chosen = found;
  }
  for (const { session, best } of chosen) {
    const change: Plan["sessionChanges"][number] = {
      sessionId: session.id, remedy: best.remedy, before: placement(session), reason: reasons[best.remedy],
    };
    if (best.after) change.after = placement(best.after);
    plan.sessionChanges.push(change);
    plan.bookingActions.push(...best.actions);
    if (best.remedy === "cancel") plan.warnings.push(`${session.title}: cancelled within the recovery horizon.`);
    if (best.after && best.after.capacity < session.capacity) plan.warnings.push(`${session.title}: replacement capacity is ${best.after.capacity}.`);
  }
  plan.bookingActions.sort((a, b) => compare(a.bookingId, b.bookingId));
  plan.totals = calculateTotals(affected.length, plan.bookingActions);
  return plan;
}
