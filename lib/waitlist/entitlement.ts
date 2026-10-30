import { packBalance } from "../domain/pack-balances";
import { localParts } from "../domain/time";
import type { Session, State } from "../domain/types";
import type { LedgerEvent } from "../store";

type Entry = NonNullable<State["waitlist"]>[number];
/** A pack or membership pays for a claimed spot only while it is valid for that class; otherwise the spot is paid at checkout. */
export function claimEntitlement(state: State, ledger: LedgerEvent[], entry: Entry, session: Session): { entitlement?: Entry["entitlement"]; note?: string } {
  const value = entry.entitlement;
  if (!value) return {};
  const expires = value.expires ?? state.syncPackBalances?.find((row) => row.customerId === entry.customerId)?.expires ?? state.bookings.find((booking) =>
    booking.customerId === entry.customerId && booking.entitlement?.name === value.name && booking.entitlement.expires)?.entitlement?.expires;
  if (expires && expires < localParts(session.start, state.studio.timezone).dateKey) return { note: `Your ${value.name} expires before this class, so this spot is paid at checkout.` };
  const balance = value.kind === "pack" ? packBalance(state, ledger, entry.customerId, value.name) : null;
  if (balance !== null && balance <= 0) return { note: `Your ${value.name} has no visits left, so this spot is paid at checkout.` };
  const { visitsLeft: _left, ...rest } = value;
  void _left;
  return { entitlement: rest, ...(balance === null ? {} : { note: `Uses 1 visit from your ${value.name} (${balance - 1} left after this class).` }) };
}
