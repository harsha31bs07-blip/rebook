import type { State } from "../domain/types";
import type { LedgerEvent } from "../store";

// Refunds still in flight during a normal approval are not owner work yet.
export const ATTENTION_AGE_MS = 2 * 60_000;

export function paymentsNeedingAttention(state: State, ledger: LedgerEvent[], now = Date.now()) {
  const latest = new Map<string, LedgerEvent>();
  for (const event of ledger) if (event.kind === "refund") latest.set(event.requestId, {
    ...event, firstAttemptAt: latest.get(event.requestId)?.firstAttemptAt ?? event.firstAttemptAt ?? event.createdAt,
  });
  return [...latest.values()].filter((event) => ["NEEDS_REVIEW", "FAILED", "CANCELLED"].includes(event.status)
    || (["REQUESTED", "PENDING"].includes(event.status) && now - Date.parse(event.firstAttemptAt ?? event.createdAt) >= ATTENTION_AGE_MS)).map((event) => {
    const booking = state.bookings.find((item) => item.id === event.bookingId);
    return { requestId: event.requestId, bookingId: event.bookingId, amount: event.amount, status: event.status,
      since: event.firstAttemptAt ?? event.createdAt, message: event.error,
      ageMinutes: Math.max(0, Math.floor((now - Date.parse(event.firstAttemptAt ?? event.createdAt)) / 60_000)),
      customer: state.customers.find((item) => item.id === booking?.customerId)?.name ?? event.bookingId };
  });
}
export type PaymentAttention = ReturnType<typeof paymentsNeedingAttention>[number];
