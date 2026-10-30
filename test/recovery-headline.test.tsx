import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import RecoveryHeadline from "../components/console/recovery-headline";
import type { summarizeRecovery } from "../lib/recovery/outcomes";

type Summary = ReturnType<typeof summarizeRecovery>;
const base: Summary = { affected: 31, kept: 9, moved: 16, saved: 25, refunded: 6, simulatedRefunded: 0, visitsReturned: 0, pending: 0, noReply: 25, revenueKept: 577,
  atStake: 712, completedRefundAmount: 135, simulatedRefundAmount: 0, credited: 0, keptAsCredit: 0, noReplyCustomers: 25, complete: false };
const disruption = { kind: "instructor_unavailable" as const, instructorId: "maya", from: "2026-11-02T05:00:00.000Z", to: "2026-11-03T05:00:00.000Z" };
const cover = { planId: "p", current: true, instructor: "Alex Rivera", status: "accepted", fee: "35.00" } as never;
const render = (recovery: Summary, extra: Record<string, unknown> = {}) => renderToStaticMarkup(<RecoveryHeadline recovery={recovery} disruption={disruption} timezone="America/New_York" approvedAt="2026-10-31T10:00:00Z" {...extra} />);

it("states where Monday stands while customers and the cover are outstanding", () => {
  const html = render(base, { covers: [cover] });
  for (const text of ["Where Monday stands", "$577.00</strong> kept of $712.00 at stake (81%)", "25 customers still have a class (9 kept, 16 moved)", "6 refunds · $135.00 back to the original payment",
    "Alex Rivera is covering · $35.00 to pay", "25 customers haven&#x27;t answered yet"]) expect(html).toContain(text);
  expect(html).not.toContain("waitlist"); expect(html).not.toContain("handled");
});
it("counts waitlist refills since approval and says Monday is handled once everything settles", () => {
  const waitlist = [{ sessionId: "s", title: "Dance", start: "x", waiting: 0, offers: [
    { id: "1", status: "claimed", amount: "22.00", createdAt: "2026-10-31T11:00:00Z", expiresAt: "x", customerName: "A" },
    { id: "2", status: "claimed", amount: "0.00", createdAt: "2026-10-31T11:00:00Z", expiresAt: "x", customerName: "B" },
    { id: "3", status: "claimed", amount: "22.00", createdAt: "2026-10-30T09:00:00Z", expiresAt: "x", customerName: "Earlier recovery" },
  ] }];
  const paid = { ...(cover as object), payout: { status: "SUCCESS", amount: "35.00" } } as never;
  const html = render({ ...base, noReply: 0, noReplyCustomers: 0, credited: 1, keptAsCredit: 22, visitsReturned: 1, complete: true }, { covers: [paid], waitlist });
  for (const text of ["Monday is handled", "+$22.00</strong> won back from the waitlist", "2 seats refilled from the waitlist", "1 customer kept $22.00 as studio credit", "1 pack visit returned", "Alex Rivera paid $35.00 with PayPal"]) expect(html).toContain(text);
  expect(html).toContain("recovery-headline handled");
});
it("is not handled while a refund waits on PayPal, and names multi-day recoveries plainly", () => {
  const html = render({ ...base, noReply: 0, noReplyCustomers: 0, pending: 1, complete: true }, { disruption: { ...disruption, to: "2026-11-05T05:00:00.000Z" } });
  expect(html).toContain("Where this recovery stands"); expect(html).toContain("1 refund waiting on PayPal");
});
