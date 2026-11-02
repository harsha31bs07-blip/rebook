import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { captureOutcome, ReturnView } from "../components/booking/paypal-return";
import NextSteps from "../components/console/next-steps";
import RecoveryHeadline from "../components/console/recovery-headline";
import { activeCovers, coverLine, coverNeedsOwner, recoveryDay, recoveryHandled } from "../lib/recovery/completion";
import type { OwnerCover } from "../lib/recovery/cover-pay";
import type { summarizeRecovery } from "../lib/recovery/outcomes";

const settled: ReturnType<typeof summarizeRecovery> = { affected: 31, kept: 9, moved: 16, saved: 25, refunded: 6, simulatedRefunded: 0, visitsReturned: 0, pending: 0, noReply: 0, paymentRefunds: 6, creditsRestored: 0, revenueKept: 577,
  atStake: 712, completedRefundAmount: 135, simulatedRefundAmount: 0, credited: 0, keptAsCredit: 0, noReplyCustomers: 0, complete: true };
const cover = (overrides: Partial<OwnerCover> = {}) => ({ planId: "plan", sessionId: "s1", instructorId: "i1", instructor: "Alex Rivera", class: "Yoga Flow", status: "accepted", current: true, fee: "35.00", ...overrides }) as OwnerCover;
const payout = (status: string, error?: string) => ({ payout: { status, amount: "35.00", itemId: undefined, error } }) as Partial<OwnerCover>;
const disruption = { kind: "instructor_unavailable" as const, instructorId: "maya", from: "2026-11-02T05:00:00.000Z", to: "2026-11-03T05:00:00.000Z" };
const headline = (covers: OwnerCover[], recovery = settled, waitlist: never[] = []) => renderToStaticMarkup(<RecoveryHeadline recovery={recovery} disruption={disruption} timezone="America/New_York" approvedAt="2026-10-31T10:00:00Z" covers={covers} waitlist={waitlist} />);

it("is not handled while any current cover is unpaid or declined, however many there are", () => {
  const paid = cover(payout("SUCCESS"));
  expect(recoveryHandled(settled, [paid])).toBe(true);
  const sam = cover({ sessionId: "s2", instructor: "Sam Lee", class: "Barre", status: "declined", next: "Priya Shah" });
  expect(recoveryHandled(settled, [paid, sam])).toBe(false);
  const html = headline([paid, sam]);
  expect(html).not.toContain("is handled"); expect(html).toContain("Where Monday stands"); expect(html).toContain("Sam Lee can&#x27;t cover Barre; ask Priya Shah");
  expect(html.indexOf("Sam Lee")).toBeLessThan(html.indexOf("still have a class"));
});

it.each([["FAILED", "failed"], ["DENIED", "failed"], ["BLOCKED", "failed"], ["RETURNED", "came back"], ["REFUNDED", "came back"], ["REVERSED", "came back"]])("names a %s payout as not paid and asks the owner", (status, word) => {
  const item = cover(payout(status));
  expect(coverLine(item)).toContain(word); expect(coverLine(item)).toContain("hasn't been paid"); expect(coverLine(item)).not.toContain("on its way");
  expect(coverNeedsOwner(item)).toBe(true); expect(recoveryHandled(settled, [item])).toBe(false);
});

it.each([["PENDING", "processing"], ["UNCLAIMED", "hasn't claimed"], ["ONHOLD", "on hold"]])("names a %s payout and keeps the recovery open without asking the owner to pay again", (status, word) => {
  const item = cover(payout(status));
  expect(coverLine(item)).toContain(word); expect(coverNeedsOwner(item)).toBe(false); expect(recoveryHandled(settled, [item])).toBe(false);
});

it("asks the owner to check a payout PayPal could not confirm", () => {
  const item = cover(payout("REQUESTED", "Check PayPal"));
  expect(coverLine(item)).toContain("PayPal hasn't confirmed"); expect(coverNeedsOwner(item)).toBe(true);
  // A timeout leaves no error at all, and the owner still has to resolve it.
  expect(coverNeedsOwner(cover(payout("REQUESTED")))).toBe(true); expect(recoveryHandled(settled, [cover(payout("REQUESTED"))])).toBe(false);
});

it("stops counting someone no longer teaching the class, unless their money is still moving", () => {
  const replaced = cover({ status: "replaced", current: false }), withdrawn = cover({ status: "withdrawn", current: false, ...payout("FAILED") });
  expect(activeCovers([replaced])).toEqual([]); expect(recoveryHandled(settled, [replaced, withdrawn])).toBe(true);
  expect(recoveryHandled(settled, [cover({ status: "replaced", current: false, ...payout("PENDING") })])).toBe(false);
});

it("keeps simulated refunds apart from money that really went back", () => {
  const html = headline([], { ...settled, refunded: 2, paymentRefunds: 2, completedRefundAmount: 45, simulatedRefunded: 4, simulatedRefundAmount: 90 });
  expect(html).toContain("2 refunds · $45.00 back to the original payment"); expect(html).toContain("4 simulated refunds · $90.00, no real money moved");
});

it("leaves refunded waitlist claims out of the waitlist figure", () => {
  const waitlist = [{ sessionId: "s", title: "Dance", start: "x", waiting: 0, offers: [
    { id: "1", status: "claimed", amount: "22.00", active: true, createdAt: "2026-10-31T11:00:00Z", expiresAt: "x", customerName: "A" },
    { id: "2", status: "claimed", amount: "22.00", active: false, createdAt: "2026-10-31T11:00:00Z", expiresAt: "x", customerName: "B" },
  ] }] as never[];
  const html = headline([], settled, waitlist);
  expect(html).toContain("+$22.00</strong> in waitlist bookings since"); expect(html).toContain("1 waitlist booking since this recovery"); expect(html).not.toContain("won back");
});

it("shows only the follow-ups a recovery has, declined covers first, and names the right day", () => {
  const props = { workspaceId: "ws", onMessages: vi.fn(), onPreview: vi.fn() };
  const bare = renderToStaticMarkup(<NextSteps {...props} day="Wednesday" covers={[]} />);
  expect(bare).not.toContain("#waitlist"); expect(bare).not.toContain("#booking-sync"); expect(bare).toContain("See what Wednesday cost"); expect(bare).not.toContain("Monday");
  expect(renderToStaticMarkup(<NextSteps {...props} covers={[]} />)).toContain("See what this recovery cost");
  const full = renderToStaticMarkup(<NextSteps {...props} showWaitlist showSync covers={[cover({ instructor: "Alex Rivera", status: "asked" }), cover({ sessionId: "s2", instructorId: "i2", instructor: "Sam Lee", status: "declined", next: null })]} />);
  expect(full).toContain('href="#waitlist"'); expect(full).toContain('href="#booking-sync"');
  expect(full.indexOf("Yoga Flow needs a new instructor")).toBeLessThan(full.indexOf("Customers choose")); expect(full).not.toContain("Sam Lee covers"); expect(full.indexOf("Customers choose")).toBeLessThan(full.indexOf("Alex Rivera covers"));
  expect(full).toContain("no one else qualified is free");
  const ask = renderToStaticMarkup(<NextSteps {...props} covers={[cover({ status: "declined", next: "Priya Shah" })]} />);
  expect(ask).toContain(">Ask Priya Shah</a>"); expect(ask).not.toContain("’s page</button>");
  // The party preview shows one substitute, so only that row offers it.
  expect(full.split("’s page</button>").length - 1).toBe(1);
});

it("names one studio day, and nothing for a longer disruption", () => {
  expect(recoveryDay(disruption, "America/New_York")).toBe("Monday");
  expect(recoveryDay({ ...disruption, to: "2026-11-05T05:00:00.000Z" }, "America/New_York")).toBeUndefined();
});

const view = (status: number, body?: Record<string, unknown>) => renderToStaticMarkup(<ReturnView outcome={captureOutcome(status, body)} timezone="America/New_York" onCheck={vi.fn()} />);
const receipt = { orderId: "O", bookingId: "b", status: "confirmed", class: "Yoga", start: "2026-11-02T12:00:00Z", end: "2026-11-02T13:00:00Z", amount: "22.00", captureId: "CAP" };

it.each([[409, { error: "Your payment is being reconciled.", code: "CHECK_PAYMENT_STATUS" }], [502, { error: "PayPal request failed" }], [500, { error: "Request could not be completed" }], [503, undefined], [429, { error: "Too many" }]])("never calls a %s answer a failed payment", (status, body) => {
  const html = view(status, body);
  expect(html).toContain("We haven&#x27;t confirmed this payment yet"); expect(html).toContain("Check this payment again"); expect(html).toContain("don&#x27;t pay again"); expect(html).not.toContain("not completed");
});

it("says the payment stopped only when the server rules out a charge", () => {
  const restart = view(410, { error: "Your seat hold expired. Start checkout again.", code: "RESTART_CHECKOUT" });
  expect(restart).toContain("Payment not completed"); expect(restart).toContain("Your seat hold expired"); expect(restart).not.toContain("Check this payment again");
  expect(view(422, { error: "Payment declined.", code: "INSTRUMENT_DECLINED" })).toContain("Payment declined");
  expect(view(422, { error: "PayPal hasn't approved this payment yet.", code: "ORDER_NOT_APPROVED" })).toContain("Payment not approved yet");
  expect(view(404, { error: "Checkout not found" })).toContain("We can&#x27;t find this payment");
});

it("shows the booking as it stands now on a later visit", () => {
  const booked = view(200, { ...receipt, current: { class: "Yoga", start: receipt.start, end: receipt.end, status: "confirmed", changed: false } });
  expect(booked).toContain("You&#x27;re booked"); expect(booked).toContain("capture CAP");
  const moved = view(200, { ...receipt, current: { class: "Pilates", start: "2026-11-03T12:00:00Z", end: "2026-11-03T13:00:00Z", status: "moved", changed: true } });
  expect(moved).toContain("Your booking has changed"); expect(moved).toContain("Pilates"); expect(moved).toContain("You first booked Yoga"); expect(moved).not.toContain("You&#x27;re booked");
  const refunded = view(200, { ...receipt, current: { class: "Yoga", start: receipt.start, end: receipt.end, status: "refunded", changed: true } });
  expect(refunded).toContain("no longer active"); expect(refunded).toContain("refunded"); expect(refunded).not.toContain("You&#x27;re booked");
  expect(view(200, { ...receipt, spotTaken: true })).toContain("this spot was just taken");
  expect(view(200, {})).toContain("We haven&#x27;t confirmed this payment yet");
});

it("doesn't call a returned visit or restored credit a payment refund", () => {
  const html = headline([], { ...settled, refunded: 2, paymentRefunds: 0, completedRefundAmount: 0, visitsReturned: 1, creditsRestored: 1 });
  expect(html).not.toContain("back to the original payment"); expect(html).not.toContain("refund ·");
  expect(html).toContain("1 pack visit returned"); expect(html).toContain("1 booking returned to studio credit");
});
