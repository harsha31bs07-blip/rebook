import type { Booking, BookingAction, Customer, Plan, Remedy, Session, State, Weights } from "../domain/types";
import { byId, DAY, fitsPreferences, fromCents, localParts, MINUTE, overlaps, toCents } from "../domain/time";

export const defaultWeights: Weights = {
  substitute: 0, moveRoom: 1_000_000, moveTime: 2_000_000, cancel: 1_000_000_000,
  weekdayChange: 60, timeShift: 0.01, delay: 40, refund: 10,
};

export const isActiveBooking = (booking: Booking): boolean =>
  booking.status === "confirmed" || booking.status === "moved";

type BookingCalendar = Pick<State, "sessions" | "bookings"> & { originalSessions: Session[] };
const changedTime = (before: Session, after: Session) => Date.parse(before.start) !== Date.parse(after.start) || Date.parse(before.end) !== Date.parse(after.end);

export function hasCustomerConflict(booking: Booking, before: Session, after: Session, calendar: BookingCalendar): boolean {
  return calendar.bookings.some((other) => {
    if (!isActiveBooking(other) || other.customerId !== booking.customerId || other.sessionId === before.id) return false;
    const session = calendar.sessions.find((item) => item.id === other.sessionId);
    if (!session || !overlaps(after.start, after.end, session.start, session.end)) return false;
    const original = calendar.originalSessions.find((item) => item.id === session.id) ?? session;
    // Existing overlaps are unrelated to this recovery when neither class changes time.
    return changedTime(before, after) || changedTime(original, session);
  });
}

export function actionsFor(
  bookings: Booking[], customers: Customer[], before: Session, after: Session | undefined, tz: string, calendar?: BookingCalendar,
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
    } else if (calendar && hasCustomerConflict(booking, before, after, calendar)) {
      reason = "Recovery would overlap the customer's other class; refund the booking.";
    } else if (retained >= after.capacity) reason = "Replacement capacity is full; earlier booking IDs take priority.";

    if (reason) return { bookingId: booking.id, customerId: booking.customerId, action: "refund", amount: booking.amount, reason };
    retained += 1;
    return {
      bookingId: booking.id, customerId: booking.customerId, action: moved ? "move" : "keep",
      amount: booking.amount, reason: moved ? "New time fits the customer's availability." : "Booking stays at the same time.",
    };
  });
}

/** Unaffected classes reserve customers first, followed by recoveries in session-ID order. */
export function recoveryActions(state: State, changes: Plan["sessionChanges"]): BookingAction[] {
  const affected = new Set(changes.map((item) => item.sessionId));
  const calendar: BookingCalendar = { originalSessions: state.sessions,
    sessions: state.sessions.filter((item) => !affected.has(item.id)),
    bookings: state.bookings.filter((item) => !affected.has(item.sessionId)) };
  const actions: BookingAction[] = [];
  for (const change of [...changes].sort((a, b) => byId({ id: a.sessionId }, { id: b.sessionId }))) {
    const before = state.sessions.find((item) => item.id === change.sessionId);
    if (!before) continue;
    const room = state.rooms.find((item) => item.id === change.after?.roomId);
    const after = change.after && change.remedy !== "cancel" ? { ...before, ...change.after, capacity: Math.min(before.capacity, room?.capacity ?? before.capacity) } : undefined;
    const bookings = state.bookings.filter((item) => item.sessionId === before.id);
    const next = actionsFor(bookings, state.customers, before, after, state.studio.timezone, calendar);
    actions.push(...next);
    if (after) {
      calendar.sessions.push(after);
      calendar.bookings.push(...bookings.filter((booking) => next.some((item) => item.bookingId === booking.id && item.action !== "refund")));
    }
  }
  return actions.sort((a, b) => byId({ id: a.bookingId }, { id: b.bookingId }));
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
