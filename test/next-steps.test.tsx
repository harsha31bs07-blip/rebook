import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import NextSteps from "../components/console/next-steps";
import PartyPreview from "../components/console/party-preview";
import type { OwnerCover } from "../lib/recovery/cover-pay";

const cover = (overrides: Partial<OwnerCover> = {}) => ({ planId: "plan", sessionId: "session-001", instructor: "Alex Rivera", original: "Maya Chen", class: "Yoga Flow",
  when: "Mon 7:00 AM", status: "accepted", respondedBy: "instructor", fee: "35.00", path: "/i/cover-token", payout: undefined, payee: true, ...overrides }) as OwnerCover;

it("shows the three follow-ups with live status after approval", () => {
  const html = renderToStaticMarkup(<NextSteps workspaceId="ws-1234567" summary={{ sent: 3, replied: 2, waiting: 1, notSent: 27 }} covers={[cover()]}
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
