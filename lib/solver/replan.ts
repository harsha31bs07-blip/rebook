import type { BookingAction, Disruption, Placement, Plan, Remedy, ReplanOptions, Session, State } from "../domain/types";
import { DisruptionSchema, ReplanOptionsSchema } from "../domain/schemas";
import { addLocalDays, byId, compare, DAY, iso, localParts, MINUTE, zonedTimeToUtc } from "../domain/time";
import { actionsFor, calculateTotals, compareObjectives, defaultWeights, isActiveBooking, remedyPriority, scoreCandidate, SLOT_MS, type CandidateObjective } from "./score";
import { affectedSessions, feasibilityErrors } from "./validate";

export { applyPlan } from "./validate";

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

/**
 * Greedy, deterministic allocation in session-ID order. Each chosen remedy reserves its resources.
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
  const plan: Plan = {
    disruption: structuredClone(disruption), now, sessionChanges: [], bookingActions: [],
    totals: calculateTotals(0, []), warnings: [],
  };
  for (const session of affected) {
    const bookings = state.bookings.filter((booking) => booking.sessionId === session.id);
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
    const cancelledActions = actionsFor(bookings, state.customers, session, undefined, tz);
    let best: Candidate = {
      remedy: "cancel", actions: cancelledActions,
      objective: objective("cancel", undefined, cancelledActions),
    };
    const consider = (remedy: Remedy, candidate: Session) => {
      if (feasibilityErrors(working, candidate, disruption).length) return;
      const actions = actionsFor(bookings, state.customers, session, candidate, tz, { ...working, originalSessions: state.sessions });
      const candidateObjective = objective(remedy, candidate, actions);
      if (compareObjectives(candidateObjective, best.objective) < 0) {
        best = { remedy, after: candidate, actions, objective: candidateObjective };
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
    if (best.objective.refunds > unavoidableRefunds || best.objective.priority >= 2) {
      const duration = Date.parse(session.end) - Date.parse(session.start);
      const original = localParts(session.start, tz);
      const originalClock = original.minutesOfDay;
      const originalTime = `${String(Math.floor(originalClock / 60)).padStart(2, "0")}:${String(Math.floor(originalClock % 60)).padStart(2, "0")}`;
      const nextDayStart = Date.parse(zonedTimeToUtc(addLocalDays(original.dateKey, 1), originalTime, tz)) + (originalClock % 1) * MINUTE;
      // Evaluate the policy's preferred move first. Reaching the retention upper
      // bound here proves that no other move can improve this session's objective.
      if (nextDayStart >= Date.parse(now) && nextDayStart + duration <= horizon) {
        for (const instructor of instructors) {
          for (const room of rooms) {
            consider("move_time", { ...session, instructorId: instructor.id, roomId: room.id,
              capacity: Math.min(session.capacity, room.capacity), start: iso(nextDayStart), end: iso(nextDayStart + duration) });
          }
        }
      }
      if (best.objective.refunds > unavoidableRefunds || best.objective.priority > 2) {
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
            for (const customer of state.customers) {
              for (const preference of customer.prefs.windows) {
                if (preference.weekday !== dayOfWeek) continue;
                slots.add(Date.parse(zonedTimeToUtc(dateKey, preference.from, tz)));
                slots.add(Date.parse(zonedTimeToUtc(dateKey, preference.to, tz)) - duration);
              }
            }
            for (const start of [...slots].filter((slot) => slot >= open && slot <= last).sort((a, b) => a - b)) {
              if (start === Date.parse(session.start)) continue;
              for (const instructor of instructors) {
                if (!instructor.skills.includes(session.classType)) continue;
                for (const room of rooms) {
                  if (!room.supports.includes(session.classType)) continue;
                  consider("move_time", { ...session, instructorId: instructor.id, roomId: room.id,
                    capacity: Math.min(session.capacity, room.capacity), start: iso(start), end: iso(start + duration) });
                }
              }
            }
          }
        }
      }
    }
    const change: Plan["sessionChanges"][number] = {
      sessionId: session.id, remedy: best.remedy, before: placement(session), reason: reasons[best.remedy],
    };
    if (best.after) {
      change.after = placement(best.after); working.sessions.push(best.after);
      working.bookings.push(...bookings.filter((booking) => best.actions.some((action) => action.bookingId === booking.id && action.action !== "refund")));
    }
    plan.sessionChanges.push(change);
    plan.bookingActions.push(...best.actions);
    if (best.remedy === "cancel") plan.warnings.push(`${session.title}: cancelled within the recovery horizon.`);
    if (best.after && best.after.capacity < session.capacity) plan.warnings.push(`${session.title}: replacement capacity is ${best.after.capacity}.`);
  }
  plan.bookingActions.sort((a, b) => compare(a.bookingId, b.bookingId));
  plan.totals = calculateTotals(affected.length, plan.bookingActions);
  return plan;
}
