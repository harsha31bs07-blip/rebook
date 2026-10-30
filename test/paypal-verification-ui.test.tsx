import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MoneyVerification } from "../lib/paypal/verify";
import { verificationNextStep } from "../lib/paypal/verification-result";

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[] }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => {
  const index = hooks.cursor++;
  if (!(index in hooks.slots)) hooks.slots[index] = initial;
  return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = value; }];
} }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/client/api", () => import("../lib/client/api"));
vi.mock("@/lib/client/scheduler-mapping", () => import("../lib/client/scheduler-mapping"));
vi.mock("@/lib/domain/time", () => import("../lib/domain/time"));
import PayPalVerification, { VerificationResult } from "../components/console/paypal-verification";
import { RefundResults } from "../components/console/plan-panel";
import { seedStudio } from "../lib/seed/seed";

const result: MoneyVerification = { checkedAt: "2026-11-05T10:42:00Z", items: [
  ...Array.from({ length: 6 }, (_, index) => ({ kind: "refund" as const, label: `Customer ${index} · Yoga`, amount: "25.00", currency: "USD", rebook: "COMPLETED", paypal: "COMPLETED", source: "PayPal Agent Toolkit" as const, match: "match" as const })),
  { kind: "payout", label: "Alex · Pilates", amount: "35.00", currency: "USD", rebook: "SUCCESS", paypal: "SUCCESS", source: "Payouts API", match: "match" },
], summary: { checked: 7, matched: 7, mismatched: 0, unavailable: 0 } };

beforeEach(() => { hooks.cursor = 0; hooks.slots = []; });
afterEach(() => { vi.unstubAllGlobals(); });
function render() { hooks.cursor = 0; return PayPalVerification({ workspaceId: "workspace1", timezone: "UTC" }); }
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element as ReactElement<Record<string, unknown>>, ...elements(element.props.children)];
}
function click(tree: ReactNode) { return (elements(tree).find((element) => element.type === "button")!.props.onClick as () => void)(); }

it("announces the match summary with local checked time and expandable named receipts", () => {
  const html = renderToStaticMarkup(<VerificationResult result={result} timezone="UTC" />);
  expect(html).toContain('role="status"'); expect(html).toContain("6 of 6 refunds and 1 payout match PayPal");
  expect(html).toContain("10:42"); expect(html).toContain('dateTime="2026-11-05T10:42:00Z"');
  expect(html).toContain("<details>"); expect(html).toContain("View PayPal verification details");
  expect(html).toContain("PayPal Agent Toolkit"); expect(html).toContain("Payouts API"); expect(html).toContain("Alex");
});

it.each(["mismatch", "not-found", "unavailable", "paypal-ahead"] as const)("provides a plain-language next step for %s", (match) => {
  const html = renderToStaticMarkup(<VerificationResult result={{ ...result, items: [{ ...result.items[0], match }] }} timezone="UTC" />);
  expect(html).toContain(verificationNextStep(match));
  if (["mismatch", "not-found"].includes(match)) expect(html).toContain('class="warning"');
});

it("shows an honest empty state for simulated-only money", () => {
  expect(renderToStaticMarkup(<VerificationResult result={{ checkedAt: result.checkedAt, items: [], summary: { checked: 0, matched: 0, mismatched: 0, unavailable: 0 } }} timezone="UTC" />)).toContain("Simulated refunds are skipped");
});

it("shows the button in approved refund results even for a cover-only recovery", () => {
  const state = seedStudio();
  expect(renderToStaticMarkup(createElement(RefundResults, { state, results: [] }))).not.toContain("Verify with PayPal");
  expect(renderToStaticMarkup(createElement(RefundResults, { state, results: [], workspaceId: "workspace1" }))).toContain("Verify with PayPal");
});

it("shows pack balance changes and the booking-system CSV download after a visit return", () => {
  const state = seedStudio(), booking = state.bookings[0];
  booking.entitlement = { kind: "pack", name: "10 Class Pack", visitsLeft: 3 };
  const html = renderToStaticMarkup(createElement(RefundResults, { state, results: [{ bookingId: booking.id, status: "VISIT_RETURNED" }], workspaceId: "workspace1" }));
  expect(html).toContain("Returns 1 visit · 10 Class Pack · 3 → 4 left");
  expect(html).toContain('href="/api/workspaces/workspace1/pack-balances"');
  expect(html).toContain("Download pack balance changes (CSV)");
  expect(html).toContain("Apply these in your booking system so balances match.");
  const later = renderToStaticMarkup(createElement(RefundResults, { state, results: [], workspaceId: "workspace1", ledger: [{
    id: "event", workspaceId: "workspace1", bookingId: booking.id, kind: "refund", requestId: "choice:link", amount: "0.00", status: "VISIT_RETURNED",
    paypalId: "", captureId: "", createdAt: "2026-11-05T12:00:00Z",
  }] }));
  expect(later).toContain("Download pack balance changes (CSV)");
});

it("disables the button and announces progress, then shows the server verification", async () => {
  let resolve!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>((done) => { resolve = done; })); vi.stubGlobal("fetch", fetch);
  const operation = click(render());
  const checking = render();
  expect(elements(checking).find((element) => element.type === "button")!.props.disabled).toBe(true);
  expect(renderToStaticMarkup(checking)).toContain("Checking sandbox refunds and cover payouts");
  resolve(Response.json(result)); await operation;
  // onClick intentionally discards the promise; drain the request/json microtasks.
  await vi.waitFor(() => { expect(hooks.slots[1]).toBe(false); });
  expect(renderToStaticMarkup(render())).toContain("6 of 6 refunds and 1 payout match PayPal");
  expect(fetch).toHaveBeenCalledWith("/api/workspaces/workspace1/verify", expect.objectContaining({ method: "POST" }));
});

it("recovers from a rate-limited check with an accessible error and an enabled retry", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "busy" }, { status: 429 })));
  click(render()); await vi.waitFor(() => { expect(hooks.slots[1]).toBe(false); });
  const tree = render(), html = renderToStaticMarkup(tree);
  expect(html).toContain("could not be completed"); expect(html).toContain('role="status"');
  expect(elements(tree).find((element) => element.type === "button")!.props.disabled).toBe(false);
});
