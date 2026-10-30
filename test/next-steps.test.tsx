import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import NextSteps from "../components/console/next-steps";
import CoverPay from "../components/console/cover-pay";
import PartyPreview from "../components/console/party-preview";
import type { OwnerCover } from "../lib/recovery/cover-pay";

const cover = (overrides: Partial<OwnerCover> = {}) => ({ planId: "plan", sessionId: "session-001", instructor: "Alex Rivera", original: "Maya Chen", class: "Yoga Flow",
  when: "Mon 7:00 AM", instructorId: "instructor-02", rule: { perClass: "35.00" }, attendees: 6, estimate: false,
  status: "accepted", current: true, respondedBy: "instructor", fee: "35.00", path: "/i/cover-token", payout: undefined, payee: true, ...overrides }) as OwnerCover;

it("offers the next qualified instructor in one click after a decline, and keeps the decline as history", () => {
  const declined = renderToStaticMarkup(<CoverPay workspaceId="ws" covers={[cover({ status: "declined", next: "Priya Shah" })]} onUpdated={vi.fn()} />);
  expect(declined).toContain("Alex Rivera declined. Priya Shah is qualified, free then and suits everyone booked.");
  expect(declined).toContain(">Ask Priya Shah instead</button>"); expect(declined).not.toContain("Plan a new recovery");
  const none = renderToStaticMarkup(<CoverPay workspaceId="ws" covers={[cover({ status: "declined", next: null })]} onUpdated={vi.fn()} />);
  expect(none).toContain("no other qualified instructor is free then. Plan a new recovery for this class."); expect(none).not.toContain("instead</button>");
  const passed = renderToStaticMarkup(<CoverPay workspaceId="ws" covers={[cover({ status: "declined", current: false }), cover({ instructor: "Priya Shah", status: "asked", path: "/i/next" })]} onUpdated={vi.fn()} />);
  expect(passed).toContain("Alex Rivera covers Yoga Flow"); expect(passed).toContain("Priya Shah covers Yoga Flow"); expect(passed).not.toContain("instead</button>");
  expect(passed.split('href="/i/').length - 1).toBe(1); expect(passed).toContain('href="/i/next"'); expect(passed).not.toContain('href="/i/cover-token"');
  const steps = renderToStaticMarkup(<NextSteps workspaceId="ws" covers={[cover({ status: "declined", current: false }), cover({ instructor: "Priya Shah", status: "asked" })]} onMessages={vi.fn()} onPreview={vi.fn()} />);
  expect(steps).toContain("Priya Shah covers Yoga Flow"); expect(steps).not.toContain("Alex Rivera covers");
});

it("shows the three follow-ups with live status after approval", () => {
  const html = renderToStaticMarkup(<NextSteps workspaceId="ws-1234567" summary={{ sent: 3, replied: 2, waiting: 1, closed: 0, notSent: 27 }} covers={[cover()]}
    customerPath="/c/token" onMessages={vi.fn()} onPreview={vi.fn()} />);
  expect(html).toContain("What happens next"); expect(html).toContain("2 of 30 replied · 3 sent");
  expect(html).toContain("Alex Rivera covers Yoga Flow"); expect(html).toContain("$35.00 to pay"); expect(html).toContain('href="#cover-instructors"');
  expect(html).toContain("See a customer"); expect(html).toContain('href="/w/ws-1234567/dashboard#recovery-analyst"');
});

it("drops the pay shortcut once PayPal has the payout, and hides cover steps without a substitute", () => {
  const paid = renderToStaticMarkup(<NextSteps workspaceId="ws" covers={[cover({ payout: { status: "SUCCESS", amount: "35.00", itemId: "ITEM", error: undefined } })]} onMessages={vi.fn()} onPreview={vi.fn()} />);
  expect(paid).toContain("paid with PayPal"); expect(paid).not.toContain("#cover-instructors");
  expect(renderToStaticMarkup(<NextSteps workspaceId="ws" covers={[]} onMessages={vi.fn()} onPreview={vi.fn()} />)).not.toContain("covers");
});

it("frames the real private page for the chosen party", () => {
  const html = renderToStaticMarkup(<PartyPreview initial="instructor" customerPath="/c/token" coverPath="/i/cover-token" instructor="Alex Rivera" onClose={vi.fn()} />);
  expect(html).toContain('src="/i/cover-token"'); expect(html).toContain('aria-selected="true"'); expect(html).toContain("Alex Rivera (cover)");
  expect(html).toContain("Anything you do here really happens");
});
