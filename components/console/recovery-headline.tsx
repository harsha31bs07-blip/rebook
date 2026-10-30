import type { Disruption } from "../../lib/domain/types";
import { localParts } from "../../lib/domain/time";
import type { summarizeRecovery } from "../../lib/recovery/outcomes";
import type { OwnerCover } from "../../lib/recovery/cover-pay";
import type { ownerWaitlist } from "../../lib/waitlist/service";

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const count = (value: number, word: string, plural = `${word}s`) => `${value} ${value === 1 ? word : plural}`;

/** The whole recovery in one statement, updated as customers answer, seats refill and the substitute is paid. */
export default function RecoveryHeadline({ recovery, disruption, timezone, approvedAt, covers = [], waitlist = [] }: {
  recovery: ReturnType<typeof summarizeRecovery>; disruption: Disruption; timezone: string; approvedAt: string;
  covers?: OwnerCover[]; waitlist?: ReturnType<typeof ownerWaitlist>;
}) {
  const from = localParts(disruption.from, timezone), last = localParts(new Date(Date.parse(disruption.to) - 1).toISOString(), timezone);
  const day = from.dateKey === last.dateKey ? new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(new Date(disruption.from)) : undefined;
  const offers = waitlist.flatMap((item) => item.offers).filter((offer) => offer.createdAt >= approvedAt);
  const claimed = offers.filter((offer) => offer.status === "claimed"), open = offers.filter((offer) => offer.status === "offered").length;
  const wonBack = claimed.reduce((sum, offer) => sum + Number(offer.amount ?? 0), 0);
  const refunded = recovery.refunded + recovery.simulatedRefunded, refundedAmount = recovery.completedRefundAmount + recovery.simulatedRefundAmount;
  const cover = covers.find((item) => item.current) ?? covers[0];
  const coverPaid = !cover || cover.payout?.status === "SUCCESS";
  const handled = recovery.complete && recovery.pending === 0 && coverPaid;
  const share = recovery.atStake > 0 ? Math.round(recovery.revenueKept / recovery.atStake * 100) : 100;
  const coverLine = cover && (cover.payout?.status === "SUCCESS" ? `${cover.instructor} paid ${money(Number(cover.payout.amount))} with PayPal`
    : cover.payout ? `${cover.instructor}'s ${money(Number(cover.payout.amount))} payout is on its way`
    : cover.status === "accepted" ? `${cover.instructor} is covering · ${money(Number(cover.fee))} to pay` : cover.status === "declined" ? `${cover.instructor} can't cover; ask the next instructor`
    : `${cover.instructor} hasn't answered the cover request yet`);
  const lines = [
    `${count(recovery.kept + recovery.moved, "customer")} still ${recovery.kept + recovery.moved === 1 ? "has" : "have"} a class (${recovery.kept} kept, ${recovery.moved} moved)`,
    refunded > 0 && `${count(refunded, "refund")} · ${money(refundedAmount)} back to the original payment`,
    recovery.credited > 0 && `${count(recovery.credited, "customer")} kept ${money(recovery.keptAsCredit)} as studio credit`,
    recovery.visitsReturned > 0 && `${count(recovery.visitsReturned, "pack visit")} returned`,
    claimed.length > 0 ? `${count(claimed.length, "seat")} refilled from the waitlist${open ? ` · ${count(open, "offer")} open` : ""}`
      : open > 0 && `${count(open, "waitlist offer")} open for freed seats`,
    coverLine,
    recovery.pending > 0 && `${count(recovery.pending, "refund")} waiting on PayPal`,
    recovery.noReplyCustomers > 0 && `${count(recovery.noReplyCustomers, "customer")} haven't answered yet; their links stay open until class`,
  ].filter((line): line is string => typeof line === "string");
  return <section className={`recovery-headline${handled ? " handled" : ""}`} aria-labelledby="recovery-headline-title">
    <h3 id="recovery-headline-title">{handled ? `${day ?? "This recovery"} is handled` : `Where ${day ?? "this recovery"} stands`}</h3>
    <p className="recovery-net"><strong>{money(recovery.revenueKept)}</strong> kept of {money(recovery.atStake)} at stake ({share}%){wonBack > 0 && <> · <strong>+{money(wonBack)}</strong> won back from the waitlist</>}</p>
    <ul>{lines.map((line) => <li key={line}>{line}</li>)}</ul>
  </section>;
}
