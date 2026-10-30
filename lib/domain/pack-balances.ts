import type { Booking, Plan, State } from "./types";
import type { LedgerEvent } from "../store";

export type PackBalanceChange = { before: number; after: number };

/** Ledger order is durable insertion order. A replay of the same return is counted once. */
export function packReturns(ledger: LedgerEvent[]): LedgerEvent[] {
  const seen = new Set<string>();
  return ledger.filter((event) => {
    if (event.kind !== "refund" || event.status !== "VISIT_RETURNED" || seen.has(event.bookingId)) return false;
    seen.add(event.bookingId); return true;
  });
}

/** Imported balances are after booking; the lowest snapshot includes every imported reservation. */
export function packBalance(state: State, ledger: LedgerEvent[], customerId: string, packName: string): number | null {
  const bookings = state.bookings.filter((booking) => booking.customerId === customerId && booking.entitlement?.kind === "pack" && booking.entitlement.name === packName);
  const balances = bookings.flatMap((booking) => booking.entitlement?.visitsLeft === undefined ? [] : [booking.entitlement.visitsLeft]);
  if (!balances.length) return null;
  const ids = new Set(bookings.map((booking) => booking.id));
  return Math.min(...balances) + packReturns(ledger).filter((event) => ids.has(event.bookingId)).length;
}

/** A completed return keeps its historical before/after; an unreturned visit previews the next change. */
export function packReturnBalance(state: State, ledger: LedgerEvent[], booking: Booking): PackBalanceChange | undefined {
  if (booking.entitlement?.kind !== "pack") return undefined;
  const returned = packReturns(ledger), index = returned.findIndex((event) => event.bookingId === booking.id);
  const before = packBalance(state, index < 0 ? ledger : returned.slice(0, index), booking.customerId, booking.entitlement.name);
  return before === null ? undefined : { before, after: before + 1 };
}

/** Preview multiple returns against the same pack in plan order, including any earlier settled returns. */
export function plannedPackBalances(state: State, ledger: LedgerEvent[], plan: Plan): Map<string, PackBalanceChange> {
  const balances = new Map<string, PackBalanceChange>(), pending = new Map<string, number>();
  const returned = new Set(packReturns(ledger).map((event) => event.bookingId));
  for (const action of plan.bookingActions) {
    const booking = state.bookings.find((item) => item.id === action.bookingId);
    if (booking?.entitlement?.kind !== "pack") continue;
    const balance = packReturnBalance(state, ledger, booking);
    if (!balance) continue;
    const key = JSON.stringify([booking.customerId, booking.entitlement.name]);
    const offset = returned.has(booking.id) ? 0 : pending.get(key) ?? 0;
    balances.set(booking.id, { before: balance.before + offset, after: balance.after + offset });
    if (action.action === "refund" && !returned.has(booking.id)) pending.set(key, offset + 1);
  }
  return balances;
}
