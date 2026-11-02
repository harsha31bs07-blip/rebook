import type { Disruption } from "../../lib/domain/types";
import type { summarizeRecovery } from "../../lib/recovery/outcomes";
import type { OwnerCover } from "../../lib/recovery/cover-pay";
import { activeCovers, coverLine, coverNeedsOwner, recoveryDay, recoveryHandled } from "../../lib/recovery/completion";
import type { ownerWaitlist } from "../../lib/waitlist/service";

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const count = (value: number, word: string, plural = `${word}s`) => `${value} ${value === 1 ? word : plural}`;

/** The whole recovery in one statement, updated as customers answer, seats refill and each substitute is paid. */
export default function RecoveryHeadline({ recovery, disruption, timezone, approvedAt, covers = [], waitlist = [] }: {
  recovery: ReturnType<typeof summarizeRecovery>; disruption: Disruption; timezone: string; approvedAt: string;
  covers?: OwnerCover[]; waitlist?: ReturnType<typeof ownerWaitlist>;
}) {
  const day = recoveryDay(disruption, timezone);
  const offers = waitlist.flatMap((item) => item.offers).filter((offer) => offer.createdAt >= approvedAt);
  // Timing is all that links these to the recovery, so they are named as bookings since it, and a refunded claim doesn't count.
  const claimed = offers.filter((offer) => offer.status === "claimed" && offer.active !== false), open = offers.filter((offer) => offer.status === "offered").length;
  const waitlistRevenue = claimed.reduce((sum, offer) => sum + Number(offer.amount ?? 0), 0);
  const active = activeCovers(covers), handled = recoveryHandled(recovery, covers);
  const share = recovery.atStake > 0 ? Math.round(recovery.revenueKept / recovery.atStake * 100) : 100;
  const lines = [
    ...active.filter(coverNeedsOwner).map(coverLine),
    `${count(recovery.kept + recovery.moved, "customer")} still ${recovery.kept + recovery.moved === 1 ? "has" : "have"} a class (${recovery.kept} kept, ${recovery.moved} moved)`,
    recovery.refunded > 0 && `${count(recovery.refunded, "refund")} · ${money(recovery.completedRefundAmount)} back to the original payment`,
    recovery.simulatedRefunded > 0 && `${count(recovery.simulatedRefunded, "simulated refund")} · ${money(recovery.simulatedRefundAmount)}, no real money moved`,
    recovery.credited > 0 && `${count(recovery.credited, "customer")} kept ${money(recovery.keptAsCredit)} as studio credit`,
    recovery.visitsReturned > 0 && `${count(recovery.visitsReturned, "pack visit")} returned`,
    claimed.length > 0 ? `${count(claimed.length, "waitlist booking")} since this recovery${open ? ` · ${count(open, "offer")} open` : ""}`
      : open > 0 && `${count(open, "waitlist offer")} open for freed seats`,
    ...active.filter((cover) => !coverNeedsOwner(cover)).map(coverLine),
    recovery.pending > 0 && `${count(recovery.pending, "refund")} waiting on PayPal`,
    recovery.noReplyCustomers > 0 && `${count(recovery.noReplyCustomers, "customer")} haven't answered yet; their links stay open until class`,
  ].filter((line): line is string => typeof line === "string");
  return <section className={`recovery-headline${handled ? " handled" : ""}`} aria-labelledby="recovery-headline-title">
    <h3 id="recovery-headline-title">{handled ? `${day ?? "This recovery"} is handled` : `Where ${day ?? "this recovery"} stands`}</h3>
    <p className="recovery-net"><strong>{money(recovery.revenueKept)}</strong> kept of {money(recovery.atStake)} at stake ({share}%){waitlistRevenue > 0 && <> · <strong>+{money(waitlistRevenue)}</strong> in waitlist bookings since</>}</p>
    <ul>{lines.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul>
  </section>;
}
