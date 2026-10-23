import type { Booking, BookingAction, Customer, Plan, Remedy, Session, Weights } from "../domain/types";
import { byId, DAY, fitsPreferences, fromCents, localParts, MINUTE, toCents } from "../domain/time";

export const defaultWeights: Weights = {
  substitute: 0, moveRoom: 1_000_000, moveTime: 2_000_000, cancel: 1_000_000_000,
  weekdayChange: 60, timeShift: 0.01, delay: 40, refund: 10,
};

export const isActiveBooking = (booking: Booking): boolean =>
  booking.status === "confirmed" || booking.status === "moved";

export function actionsFor(
  bookings: Booking[], customers: Customer[], before: Session, after: Session | undefined, tz: string,
): BookingAction[] {
  const people = new Map(customers.map((customer) => [customer.id, customer]));
  let retained = 0;
  return [...bookings].filter(isActiveBooking).sort(byId).map((booking) => {
    const customer = people.get(booking.customerId);
    const moved = after !== undefined && (Date.parse(after.start) !== Date.parse(before.start) ||
      Date.parse(after.end) !== Date.parse(before.end));
    let reason: string | undefined;
    if (!after) reason = "Session cancelled; refund the booking.";
    else if (!customer) reason = "Customer preferences unavailable; refund the booking.";
    else if (customer.prefs.refundOnly) reason = "Customer requests a refund after a disruption.";
    else if (after.instructorId !== before.instructorId && !customer.prefs.acceptsSubstitute &&
      customer.prefs.preferredInstructorIds !== undefined &&
      !customer.prefs.preferredInstructorIds.includes(after.instructorId)) {
      reason = "Replacement instructor is outside the customer's preferences.";
    } else if (moved && !fitsPreferences(customer, after.start, after.end, tz)) {
      reason = "New time does not fit the customer's availability.";
    } else if (retained >= after.capacity) reason = "Replacement capacity is full; earlier booking IDs take priority.";

    if (reason) return { bookingId: booking.id, customerId: booking.customerId, action: "refund", amount: booking.amount, reason };
    retained += 1;
    return {
      bookingId: booking.id, customerId: booking.customerId, action: moved ? "move" : "keep",
      amount: booking.amount, reason: moved ? "New time fits the customer's availability." : "Booking stays at the same time.",
    };
  });
}

export function scoreCandidate(
  remedy: Remedy, before: Session, after: Session | undefined,
  actions: BookingAction[], weights: Weights, tz: string,
): number {
  const base = remedy === "move_room" ? weights.moveRoom : remedy === "move_time" ? weights.moveTime : weights[remedy];
  let score = base + actions.filter((action) => action.action === "refund").length * weights.refund;
  if (after && remedy === "move_time") {
    const original = localParts(before.start, tz);
    const replacement = localParts(after.start, tz);
    score += (original.weekday === replacement.weekday ? 0 : weights.weekdayChange);
    score += Math.abs(replacement.minutesOfDay - original.minutesOfDay) * weights.timeShift;
    // Calendar days keep the original clock preferable within a day, including across DST.
    score += Math.abs(Date.parse(replacement.dateKey) - Date.parse(original.dateKey)) / DAY * weights.delay;
  }
  return score;
}

export function calculateTotals(sessionCount: number, actions: BookingAction[]): Plan["totals"] {
  let refund = 0;
  let revenue = 0;
  let kept = 0;
  let moved = 0;
  let refunded = 0;
  for (const action of actions) {
    if (action.action === "refund") { refunded += 1; refund += toCents(action.amount); }
    else {
      revenue += toCents(action.amount);
      if (action.action === "keep") kept += 1;
      else moved += 1;
    }
  }
  return { sessionsAffected: sessionCount, kept, moved, refunded, refundAmount: fromCents(refund), revenueKept: fromCents(revenue) };
}

// Public constant documents the move-time search resolution.
export const SLOT_MS = 15 * MINUTE;
