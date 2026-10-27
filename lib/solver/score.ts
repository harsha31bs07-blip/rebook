import type { Booking, BookingAction, Customer, Plan, Remedy, Session, State, Weights } from "../domain/types";
import { addLocalDays, byId, DAY, fromCents, localParts, MINUTE, overlaps, toCents, zonedTimeToUtc } from "../domain/time";

export const defaultWeights: Weights = {
  substitute: 0, moveRoom: 1_000_000, moveTime: 2_000_000, cancel: 1_000_000_000,
  weekdayChange: 60, timeShift: 0.01, delay: 40, refund: 10,
};

export const isActiveBooking = (booking: Booking): boolean =>
  booking.status === "confirmed" || booking.status === "moved";

/** Legacy bookings with unknown creation times precede timestamped bookings. */
export const byBookingTime = (a: Booking, b: Booking): number =>
  (a.bookedAt ? Date.parse(a.bookedAt) : -Infinity) - (b.bookedAt ? Date.parse(b.bookedAt) : -Infinity) || byId(a, b);

type BookingCalendar = Pick<State, "sessions" | "bookings"> & { originalSessions: Session[]; instructors?: State["instructors"] };
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
  return bookingActionEvaluator(bookings, customers, before, tz, calendar)(after);
}

/** Reuse immutable booking order and calendar checks while searching one class's placements. */
export function bookingActionEvaluator(
  bookings: Booking[], customers: Customer[], before: Session, tz: string, calendar?: BookingCalendar,
): (after: Session | undefined) => BookingAction[] {
  const people = new Map(customers.map((customer) => [customer.id, customer]));
  const ordered = bookings.filter(isActiveBooking).sort(byBookingTime);
  const sessions = new Map(calendar?.sessions.map((session) => [session.id, session]));
  const originals = new Map(calendar?.originalSessions.map((session) => [session.id, session]));
  const customerSessions = new Map<string, { start: number; end: number; moved: boolean }[]>();
  for (const booking of calendar?.bookings ?? []) {
    if (!isActiveBooking(booking) || booking.sessionId === before.id) continue;
    const session = sessions.get(booking.sessionId);
    if (!session) continue;
    const entries = customerSessions.get(booking.customerId) ?? [];
    entries.push({ start: Date.parse(session.start), end: Date.parse(session.end),
      moved: changedTime(originals.get(session.id) ?? session, session) });
    customerSessions.set(booking.customerId, entries);
  }
  const times = new Map<string, Map<string, string | undefined>>();
  const availability = new Map<string, { start: number; end: number }[]>();
  const actionsCache = new Map<string, BookingAction[]>();
  const beforeStart = Date.parse(before.start), beforeEnd = Date.parse(before.end);
  return (after) => {
    let retained = 0;
    const start = after ? Date.parse(after.start) : 0;
    const end = after ? Date.parse(after.end) : 0;
    const moved = after !== undefined && (start !== beforeStart || end !== beforeEnd);
    const timeKey = `${start}|${end}`;
    const actionKey = after ? `${timeKey}|${after.instructorId}|${after.capacity}` : "cancel";
    const cached = actionsCache.get(actionKey);
    if (cached) return cached;
    let timeReasons = times.get(timeKey);
    if (!timeReasons) { timeReasons = new Map(); times.set(timeKey, timeReasons); }
    let local: ReturnType<typeof localParts> | undefined;
    const actions = ordered.map((booking): BookingAction => {
      const customer = people.get(booking.customerId);
      let reason: string | undefined;
      if (!customer) reason = "Customer preferences unavailable; refund the booking.";
      else if (customer.prefs.refundOnly) reason = "Prefers a refund after a disruption.";
      else if (!after) reason = "No feasible instructor, room and time within the recovery horizon.";
      else if (after.instructorId !== before.instructorId && !customer.prefs.acceptsSubstitute &&
        !customer.prefs.preferredInstructorIds?.includes(after.instructorId)) {
        const preferred = customer.prefs.preferredInstructorIds ?? [before.instructorId];
        const name = calendar?.instructors?.find((item) => item.id === preferred[0])?.name;
        reason = preferred.length === 1 && name ? `Only books with ${name}; the replacement instructor is not accepted.` :
          "Replacement instructor is outside the customer's preferences.";
      } else {
        if (!timeReasons.has(customer.id)) {
          let fits = true;
          if (moved) {
            local ??= localParts(after.start, tz);
            const availabilityKey = `${customer.id}|${local.dateKey}`;
            let windows = availability.get(availabilityKey);
            if (!windows) {
              const { dateKey, weekday } = local;
              windows = customer.prefs.windows.filter((window) => window.weekday === weekday).map((window) => ({
                start: Date.parse(zonedTimeToUtc(dateKey, window.from, tz)),
                end: Date.parse(zonedTimeToUtc(dateKey, window.to, tz)),
              }));
              availability.set(availabilityKey, windows);
            }
            fits = end > start && windows.some((window) => start >= window.start && end <= window.end);
          }
          timeReasons.set(customer.id, !fits
            ? "New time does not fit the customer's availability."
            : customerSessions.get(customer.id)?.some((other) => start < other.end && other.start < end && (moved || other.moved))
              ? "Recovery would overlap the customer's other class; refund the booking." : undefined);
        }
        reason = timeReasons.get(customer.id);
        if (!reason && retained >= after.capacity) reason = "Replacement capacity is full; earlier bookings take priority.";
      }

      if (reason) return { bookingId: booking.id, customerId: booking.customerId, action: "refund", amount: booking.amount, reason };
      retained += 1;
      return {
        bookingId: booking.id, customerId: booking.customerId, action: moved ? "move" : "keep",
        amount: booking.amount, reason: moved ? "New time fits the customer's availability." : "Booking stays at the same time.",
      };
    });
    actionsCache.set(actionKey, actions);
    return actions;
  };
}

/** Unaffected classes reserve customers first, followed by recoveries in session-ID order. */
export function recoveryActions(state: State, changes: Plan["sessionChanges"]): BookingAction[] {
  const affected = new Set(changes.map((item) => item.sessionId));
  const calendar: BookingCalendar = { originalSessions: state.sessions, instructors: state.instructors,
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

/** Secondary cost only: refund count and remedy priority are compared first. */
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

/** These priorities are hard policy; configurable costs only break ties within a tier. */
export function remedyPriority(remedy: Remedy, before: Session, after: Session | undefined, tz: string): number {
  if (remedy === "substitute") return 0;
  if (remedy === "move_room") return 1;
  if (remedy === "cancel" || !after) return 4;
  const original = localParts(before.start, tz);
  const replacement = localParts(after.start, tz);
  return replacement.dateKey === addLocalDays(original.dateKey, 1) && replacement.minutesOfDay === original.minutesOfDay ? 2 : 3;
}

export type CandidateObjective = { refunds: number; priority: number; cost: number; key: string };
export function compareObjectives(a: CandidateObjective, b: CandidateObjective): number {
  return a.refunds - b.refunds || a.priority - b.priority || a.cost - b.cost ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
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
