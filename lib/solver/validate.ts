import type { Disruption, Plan, Session, State } from "../domain/types";
import { PlanSchema } from "../domain/schemas";
import { byId, compare, insideOpenHours, localParts, overlaps } from "../domain/time";
import { actionsFor, calculateTotals, isActiveBooking } from "./score";
import { activeConstraints } from "./constraints";

export function usesDisruptedResource(session: Session, disruption: Disruption): boolean {
  return disruption.kind === "closure" || (disruption.kind === "instructor_unavailable"
    ? session.instructorId === disruption.instructorId : session.roomId === disruption.roomId);
}

export function affectedSessions(state: State, disruption: Disruption, now: string): Session[] {
  return state.sessions.filter((session) => Date.parse(session.start) >= Date.parse(now) &&
    usesDisruptedResource(session, disruption) && overlaps(session.start, session.end, disruption.from, disruption.to))
    .sort(byId);
}

export function feasibilityErrors(state: State, session: Session, disruption?: Disruption, now?: string): string[] {
  const errors: string[] = [];
  const instructor = state.instructors.find((person) => person.id === session.instructorId);
  const room = state.rooms.find((space) => space.id === session.roomId);
  if (!instructor) errors.push("Unknown instructor");
  else {
    if (!instructor.skills.includes(session.classType)) errors.push("Instructor lacks class skill");
    if (instructor.unavailability?.some((window) => overlaps(session.start, session.end, window.from, window.to))) {
      errors.push("Instructor is unavailable");
    }
    const count = state.sessions.filter((other) => other.id !== session.id && other.instructorId === instructor.id &&
      localParts(other.start, state.studio.timezone).dateKey === localParts(session.start, state.studio.timezone).dateKey).length;
    if (count >= instructor.maxSessionsPerDay) errors.push("Instructor daily limit exceeded");
  }
  if (!room) errors.push("Unknown room");
  else {
    if (!room.supports.includes(session.classType)) errors.push("Room does not support class");
    if (session.capacity > room.capacity) errors.push("Session capacity exceeds room capacity");
  }
  if (!insideOpenHours(state.studio, session.start, session.end)) errors.push("Session outside open hours");
  for (const other of state.sessions) {
    if (other.id === session.id || !overlaps(session.start, session.end, other.start, other.end)) continue;
    if (other.instructorId === session.instructorId) errors.push(`Instructor double booking with ${other.id}`);
    if (other.roomId === session.roomId) errors.push(`Room double booking with ${other.id}`);
  }
  const active = !now || Date.parse(session.start) >= Date.parse(now) ? activeConstraints(state) : [];
  for (const constraint of [...active, ...(disruption ? [disruption] : [])]) {
    if (usesDisruptedResource(session, constraint) && overlaps(session.start, session.end, constraint.from, constraint.to)) {
      errors.push("Session overlaps disrupted resource");
    }
  }
  return errors;
}

/** Pure application: cancelled sessions leave the schedule; refund records remain for payment execution. */
export function applyPlan(state: State, plan: Plan): State {
  const result = structuredClone(state);
  const changes = new Map(plan.sessionChanges.map((change) => [change.sessionId, change]));
  const actions = new Map(plan.bookingActions.map((action) => [action.bookingId, action]));
  result.sessions = result.sessions.flatMap((session) => {
    const change = changes.get(session.id);
    if (!change) return [session];
    if (change.remedy === "cancel") return [];
    if (!change.after) return [session];
    const room = result.rooms.find((space) => space.id === change.after!.roomId);
    return [{ ...session, ...change.after, capacity: Math.min(session.capacity, room?.capacity ?? session.capacity) }];
  });
  result.bookings = result.bookings.map((booking) => {
    const action = actions.get(booking.id);
    if (!action) return booking;
    return { ...booking, status: action.action === "refund" ? "refund_pending" : action.action === "move" ? "moved" : "confirmed" };
  });
  return result;
}

export function validate(state: State, plan: Plan): { ok: boolean; errors: string[] } {
  const parsed = PlanSchema.safeParse(plan);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).sort(compare) };
  const errors: string[] = [];
  const affected = affectedSessions(state, plan.disruption, plan.now);
  const affectedIds = new Set(affected.map((session) => session.id));
  const changeIds = new Set<string>();
  for (const change of plan.sessionChanges) {
    if (changeIds.has(change.sessionId)) errors.push(`Duplicate session change: ${change.sessionId}`);
    changeIds.add(change.sessionId);
    if (!affectedIds.has(change.sessionId)) errors.push(`Unexpected session change: ${change.sessionId}`);
    const before = state.sessions.find((session) => session.id === change.sessionId);
    if (before && (before.instructorId !== change.before.instructorId || before.roomId !== change.before.roomId ||
      Date.parse(before.start) !== Date.parse(change.before.start) || Date.parse(before.end) !== Date.parse(change.before.end))) {
      errors.push(`Before placement does not match: ${change.sessionId}`);
    }
    if (change.after && before) {
      const sameTime = Date.parse(before.start) === Date.parse(change.after.start) && Date.parse(before.end) === Date.parse(change.after.end);
      if (Date.parse(before.end) - Date.parse(before.start) !== Date.parse(change.after.end) - Date.parse(change.after.start)) errors.push(`Duration changed: ${change.sessionId}`);
      if (Date.parse(change.after.start) < Date.parse(plan.now)) errors.push(`Replacement starts in the past: ${change.sessionId}`);
      if (change.remedy === "substitute" && (!sameTime || before.roomId !== change.after.roomId || before.instructorId === change.after.instructorId)) errors.push(`Invalid substitute remedy: ${change.sessionId}`);
      // Owner room overrides may also select a substitute, regardless of the original disruption kind.
      if (change.remedy === "move_room" && (!sameTime || before.roomId === change.after.roomId ||
        (!change.ownerAdjusted && (before.instructorId !== change.after.instructorId || plan.disruption.kind !== "room_unavailable")))) errors.push(`Invalid room remedy: ${change.sessionId}`);
      if (change.remedy === "move_time" && sameTime) errors.push(`Invalid time remedy: ${change.sessionId}`);
    }
  }
  for (const session of affected) if (!changeIds.has(session.id)) errors.push(`Missing session change: ${session.id}`);
  const next = applyPlan(state, plan);
  for (const session of [...next.sessions].sort(byId)) {
    // Historical sessions are still checked for resource collisions but not a new disruption.
    const disruption = Date.parse(session.start) >= Date.parse(plan.now) ? plan.disruption : undefined;
    for (const error of feasibilityErrors(next, session, disruption, plan.now)) errors.push(`${session.id}: ${error}`);
    const count = next.bookings.filter((booking) => booking.sessionId === session.id && isActiveBooking(booking)).length;
    if (count > session.capacity) errors.push(`${session.id}: Booking capacity exceeded`);
  }
  const expectedBookings = state.bookings.filter((booking) => affectedIds.has(booking.sessionId) && isActiveBooking(booking));
  const expectedIds = new Set(expectedBookings.map((booking) => booking.id));
  const actionIds = new Set<string>();
  for (const action of plan.bookingActions) {
    if (actionIds.has(action.bookingId)) errors.push(`Duplicate booking action: ${action.bookingId}`);
    actionIds.add(action.bookingId);
    if (!expectedIds.has(action.bookingId)) errors.push(`Unexpected booking action: ${action.bookingId}`);
    const booking = state.bookings.find((item) => item.id === action.bookingId);
    if (booking && (booking.customerId !== action.customerId || booking.amount !== action.amount)) errors.push(`Booking details do not match: ${action.bookingId}`);
  }
  for (const session of affected) {
    const expected = actionsFor(expectedBookings.filter((booking) => booking.sessionId === session.id), state.customers,
      session, next.sessions.find((item) => item.id === session.id), state.studio.timezone);
    for (const action of expected) {
      const actual = plan.bookingActions.find((item) => item.bookingId === action.bookingId);
      if (!actual) errors.push(`Missing booking action: ${action.bookingId}`);
      else if (actual.action !== action.action) errors.push(`Invalid booking action: ${action.bookingId}`);
    }
  }
  for (const booking of next.bookings.filter(isActiveBooking)) {
    if (!next.sessions.some((session) => session.id === booking.sessionId)) errors.push(`Active booking has no session: ${booking.id}`);
    if (!next.customers.some((customer) => customer.id === booking.customerId)) errors.push(`Active booking has no customer: ${booking.id}`);
  }
  try {
    const totals = calculateTotals(affected.length, plan.bookingActions);
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
      if (totals[key] !== plan.totals[key]) errors.push(`Totals mismatch: ${key}`);
    }
  } catch {
    errors.push("Booking amounts exceed safe integer cents");
  }
  errors.sort(compare);
  return { ok: errors.length === 0, errors };
}
