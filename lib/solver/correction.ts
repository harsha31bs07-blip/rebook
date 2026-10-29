import type { Placement, Plan, State } from "../domain/types";
import { byId } from "../domain/time";
import { deactivateConstraint } from "./constraints";
import { calculateTotals, correctionActions, hasCustomerConflict, isActiveBooking } from "./score";
import { feasibilityErrors } from "./validate";

export function samePlacement(a: Placement, b: Placement): boolean {
  return a.instructorId === b.instructorId && a.roomId === b.roomId &&
    Date.parse(a.start) === Date.parse(b.start) && Date.parse(a.end) === Date.parse(b.end);
}
const placement = ({ instructorId, roomId, start, end }: Placement): Placement => ({ instructorId, roomId, start, end });

/** Compensate only placements that still belong to this recovery. Settled booking choices stay settled. */
export function planCorrection(state: State, original: Plan & { id: string; basis?: State }, now: string): Plan {
  const working = structuredClone(deactivateConstraint(state, original.disruption));
  const sessionChanges: Plan["sessionChanges"] = [], warnings: string[] = [];
  const time = (start: string) => new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone,
    weekday: "long", hour: "numeric", minute: "2-digit" }).format(new Date(start));
  for (const change of [...original.sessionChanges].sort((a, b) => byId({ id: a.sessionId }, { id: b.sessionId }))) {
    const current = working.sessions.find((session) => session.id === change.sessionId);
    const title = current?.title ?? original.basis?.sessions.find((session) => session.id === change.sessionId)?.title ?? change.sessionId;
    let reason: string | undefined;
    if (!change.after || !current) reason = "the cancelled class has left the schedule";
    else if (Date.parse(current.start) <= Date.parse(now)) reason = "the class has already started";
    else if (!samePlacement(current, change.after)) reason = "the class changed again after this recovery";
    else if (Date.parse(change.before.start) <= Date.parse(now)) reason = "the original time has already passed";
    else if (state.bookings.some((booking) => booking.sessionId === current.id && isActiveBooking(booking) &&
      original.basis?.bookings.some((before) => before.id === booking.id && before.sessionId !== booking.sessionId))) {
      reason = "a customer chose this class after the recovery; their choice stays unchanged";
    }
    else {
      const restored = { ...current, ...change.before };
      const errors = feasibilityErrors(working, restored, undefined, now);
      const conflict = state.bookings.filter((booking) => booking.sessionId === current.id && isActiveBooking(booking))
        .some((booking) => hasCustomerConflict(booking, current, restored, { ...working, originalSessions: state.sessions }));
      if (errors.length) reason = errors[0].startsWith("Room double booking") ? "the original room is now taken"
        : errors[0].startsWith("Instructor double booking") ? "the original instructor now teaches another class" : errors[0].toLowerCase();
      else if (conflict) reason = "the original time now overlaps a customer's other class";
      else {
        const sameTime = Date.parse(current.start) === Date.parse(restored.start) && Date.parse(current.end) === Date.parse(restored.end);
        sessionChanges.push({ sessionId: current.id, before: placement(current), after: placement(restored),
          remedy: sameTime && current.roomId === restored.roomId ? "substitute"
            : sameTime && current.instructorId === restored.instructorId ? "move_room" : "move_time",
          reason: "Restored: the disruption was withdrawn." });
        working.sessions = working.sessions.map((session) => session.id === current.id ? restored : session);
      }
    }
    if (reason) warnings.push(`${title}${current ? ` stays at ${time(current.start)}` : " stays cancelled"}: ${reason}.`);
  }
  const originalBookingIds = new Set(original.bookingActions.map((action) => action.bookingId));
  const settled = state.bookings.filter((booking) => originalBookingIds.has(booking.id) && !isActiveBooking(booking));
  const refunded = settled.filter((booking) => booking.status === "refunded").length;
  if (refunded) warnings.push(`${refunded} refunds already issued stay refunded; those customers can book again.`);
  const others = settled.length - refunded + state.bookings.filter((booking) => originalBookingIds.has(booking.id) && isActiveBooking(booking) &&
    !original.sessionChanges.some((change) => change.sessionId === booking.sessionId)).length;
  if (others) warnings.push(`${others} bookings with a refund pending, studio credit or another class stay unchanged.`);
  const bookingActions = correctionActions(state, sessionChanges);
  return { disruption: structuredClone(original.disruption), correctionOf: original.id, now, sessionChanges, bookingActions,
    totals: calculateTotals(sessionChanges.length, bookingActions), warnings };
}
