import type { Plan, Session, State } from "../domain/types";
import { addLocalDays, iso, localParts, zonedTimeToUtc } from "../domain/time";
import { calculateTotals, correctionActions, hasCustomerConflict, isActiveBooking, recoveryActions } from "./score";
import { deactivateConstraint } from "./constraints";
import { applyPlan, feasibilityErrors, validate } from "./validate";

export type OwnerAdjustment = { sessionId: string; start: string; instructorId?: string; roomId?: string };

/** Shared inexpensive drag pre-check; the server still validates every session and booking. */
export function checkAdjustment(state: State, plan: Plan, input: OwnerAdjustment): { valid: boolean; message: string; session?: Session } {
  const change = plan.sessionChanges.find((item) => item.sessionId === input.sessionId);
  const before = state.sessions.find((item) => item.id === input.sessionId);
  if (!change?.after || !before) return { valid: false, message: "Only a proposed recovery block can be moved." };
  const start = Date.parse(input.start);
  if (!Number.isFinite(start)) return { valid: false, message: "Choose a valid start time." };
  const roomId = input.roomId ?? change.after.roomId;
  const room = state.rooms.find((item) => item.id === roomId);
  const session: Session = { ...before, ...change.after, instructorId: input.instructorId ?? change.after.instructorId, roomId,
    start: iso(start), end: iso(start + Date.parse(before.end) - Date.parse(before.start)),
    capacity: Math.min(before.capacity, room?.capacity ?? before.capacity) };
  const weekStart = zonedTimeToUtc(localParts(state.studio.weekStart, state.studio.timezone).dateKey, "00:00", state.studio.timezone);
  const weekEnd = zonedTimeToUtc(addLocalDays(localParts(weekStart, state.studio.timezone).dateKey, 7), "00:00", state.studio.timezone);
  if (start < Date.parse(weekStart) || Date.parse(session.end) > Date.parse(weekEnd)) return { valid: false, message: "Keep the recovery inside this studio week." };
  if (start < Date.parse(plan.now)) return { valid: false, message: "A recovery cannot start in the past." };
  const working = applyPlan(plan.correctionOf ? deactivateConstraint(state, plan.disruption) : state, plan);
  const errors = feasibilityErrors(working, session, plan.correctionOf ? undefined : plan.disruption, plan.now);
  const collision = working.sessions.find((item) => item.id !== session.id && item.instructorId === session.instructorId &&
    Date.parse(item.start) < Date.parse(session.end) && start < Date.parse(item.end));
  const instructor = state.instructors.find((item) => item.id === session.instructorId);
  const message = collision ? `${instructor?.name ?? "Instructor"} already teaches at ${new Intl.DateTimeFormat("en-US", {
    timeZone: state.studio.timezone, hour: "numeric", minute: "2-digit",
  }).format(new Date(collision.start))}.` : errors[0] ?? "";
  if (plan.correctionOf && !errors.length) {
    const bookings = state.bookings.filter((booking) => booking.sessionId === session.id && isActiveBooking(booking));
    const conflict = bookings.find((booking) => hasCustomerConflict(booking, before, session, { ...working, originalSessions: state.sessions }));
    if (conflict) return { valid: false, message: `${state.customers.find((customer) => customer.id === conflict.customerId)?.name ?? "A customer"} has another class then. Choose another time.` };
    if (bookings.length > session.capacity) return { valid: false, message: "This room cannot fit everyone. Choose a larger room." };
  }
  return { valid: errors.length === 0, message, session };
}

export function adjustPlan(state: State, plan: Plan, input: OwnerAdjustment): Plan {
  const checked = checkAdjustment(state, plan, input);
  if (!checked.valid || !checked.session) throw new Error(checked.message);
  const next = structuredClone(plan);
  const change = next.sessionChanges.find((item) => item.sessionId === input.sessionId)!;
  const before = state.sessions.find((item) => item.id === input.sessionId)!;
  const after = checked.session;
  change.after = { start: after.start, end: after.end, instructorId: after.instructorId, roomId: after.roomId };
  change.remedy = Date.parse(before.start) !== Date.parse(after.start) ? "move_time" : before.roomId !== after.roomId ? "move_room" : "substitute";
  change.ownerAdjusted = true;
  change.reason = plan.correctionOf ? "Owner adjusted the restored placement; customers were checked again."
    : "Owner adjusted the proposed placement; booking preferences were checked again.";
  next.bookingActions = (plan.correctionOf ? correctionActions : recoveryActions)(state, next.sessionChanges);
  next.totals = calculateTotals(next.sessionChanges.length, next.bookingActions);
  // Rebuild placement warnings so old capacity warnings do not survive an adjustment.
  if (!plan.correctionOf) next.warnings = next.sessionChanges.flatMap((item) => {
    const original = state.sessions.find((session) => session.id === item.sessionId)!;
    if (!item.after) return [`${original.title}: cancelled within the recovery horizon.`];
    const capacity = Math.min(original.capacity, state.rooms.find((room) => room.id === item.after!.roomId)!.capacity);
    return capacity < original.capacity ? [`${original.title}: replacement capacity is ${capacity}.`] : [];
  });
  const validation = validate(state, next);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return next;
}
