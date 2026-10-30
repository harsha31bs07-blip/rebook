import type { State } from "./types";
import type { LedgerEvent } from "../store";
import { localParts } from "./time";
import { packReturnBalance, packReturns } from "./pack-balances";

/** Quote every cell, and neutralize spreadsheet formulas before CSV escaping. */
export function packBalanceCsv(state: State, ledger: LedgerEvent[]): string {
  const rows: (string | number)[][] = [["Customer", "Email", "Pack", "Class", "Class start (studio local)", "Returned at", "Balance before", "Balance after", "Expires"]];
  for (const event of packReturns(ledger)) {
    const booking = state.bookings.find((item) => item.id === event.bookingId);
    if (booking?.entitlement?.kind !== "pack") continue;
    const customer = state.customers.find((item) => item.id === booking.customerId);
    const session = state.sessions.find((item) => item.id === booking.sessionId);
    const balance = packReturnBalance(state, ledger, booking);
    const local = session && localParts(session.start, state.studio.timezone);
    const start = local ? `${local.dateKey} ${String(Math.floor(local.minutesOfDay / 60)).padStart(2, "0")}:${String(Math.floor(local.minutesOfDay % 60)).padStart(2, "0")}` : "";
    rows.push([customer?.name ?? "", customer?.email ?? "", booking.entitlement.name, session?.title ?? "", start, event.createdAt,
      balance?.before ?? "", balance?.after ?? "", booking.entitlement.expires ?? ""]);
  }
  return rows.map((row) => row.map((value) => {
    const text = String(value), safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  }).join(",")).join("\r\n") + "\r\n";
}
