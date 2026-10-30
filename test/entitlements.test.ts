import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BookingSchema } from "../lib/domain/schemas";
import { entitlementMessage, entitlementReceipt } from "../lib/domain/entitlements";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { calculateTotals } from "../lib/solver/score";
import { executePlan } from "../lib/executor/executePlan";
import { executeRefund } from "../lib/executor/refund";
import { checkRefund, sweepRefunds } from "../lib/executor/refund-sweep";
import { lookupRefund, reconcileRefund } from "../lib/executor/reconcileRefund";
import { verifyWorkspaceMoney } from "../lib/paypal/verify";
import { draftCustomerMessages } from "../lib/ai/messages";
import { customerChoice, ownerCustomerChoices, submitChoice } from "../lib/choices/service";
import { proposeChoice } from "../lib/choices/assistant";
import { buildImport } from "../lib/import/build";
import { paymentEntitlement, ruleMapping } from "../lib/import/fields";
import { parseCsv } from "../lib/import/csv";
import { createImportedWorkspace } from "../lib/import/service";
import { buildInsights } from "../lib/insights/data";
import { getRecoverySummary, getRefundBreakdown } from "../lib/insights/analyst-tools";
import { recoveryMetric } from "../lib/insights/metrics";
import { Repository, withWorkspaceLock } from "../lib/store";

const ai = vi.hoisted(() => ({ generateJson: vi.fn() }));
vi.mock("../lib/ai/gemini", async (original) => ({ ...(await original<typeof import("../lib/ai/gemini")>()), generateJson: ai.generateJson }));
const pack = { kind: "pack", name: "10-class pack" } as const;
const membership = { kind: "membership", name: "Unlimited monthly" } as const;
let directory: string, repository: Repository;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "rebook-entitlements-")); repository = new Repository(directory);
  ai.generateJson.mockReset(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected PayPal request"); }));
});
afterEach(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); vi.unstubAllGlobals(); });

function prepared(refund: boolean) {
  const state = seedStudio();
  const initial = replan(state, demoDisruption);
  const ids = initial.bookingActions.filter((action) => (action.action === "refund") === refund).slice(0, 2).map((action) => action.bookingId);
  ids.forEach((id, index) => {
    const booking = state.bookings.find((item) => item.id === id)!;
    booking.entitlement = index ? membership : pack; booking.amount = "0.00"; delete booking.payment;
  });
  for (const booking of state.bookings) if (booking.payment) booking.payment.simulated = true;
  const workspace = repository.createWorkspace(state);
  for (const booking of state.bookings.filter((item) => item.payment)) repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id,
    kind: "capture", amount: booking.amount, captureId: booking.payment!.captureId, paypalId: booking.payment!.captureId,
    requestId: `capture:${booking.id}`, status: "SIMULATED" });
  const plan = repository.createPlan(workspace.id, replan(state, demoDisruption));
  return { state, workspace, plan, ids };
}

it("requires entitlement bookings to have zero amount and no captured payment", () => {
  const booking = seedStudio().bookings[0];
  expect(BookingSchema.safeParse({ ...booking, entitlement: pack }).success).toBe(false);
  expect(BookingSchema.safeParse({ ...booking, amount: "0.00", entitlement: pack }).success).toBe(false);
  expect(BookingSchema.safeParse({ ...booking, amount: "0.00", payment: undefined, entitlement: pack }).success).toBe(true);
});

it("preserves hero totals and excludes visits from cash totals without changing action counts", () => {
  const hero = replan(seedStudio(), demoDisruption);
  expect(hero.totals).toMatchObject({ kept: 9, moved: 16, refunded: 6, revenueKept: "577.00", refundAmount: "135.00" });
  const { plan } = prepared(true);
  expect(plan.totals).toEqual(calculateTotals(plan.sessionChanges.length, plan.bookingActions));
  expect(plan.totals).toMatchObject({ kept: 9, moved: 16, refunded: 6, revenueKept: "577.00" });
  expect(Number(plan.totals.refundAmount)).toBeLessThan(135);
});

it("returns pack and membership visits once, settles approval, and skips all PayPal checks on replay", async () => {
  const { workspace, plan, ids } = prepared(true);
  const result = await executePlan(workspace.id, plan.id, repository);
  expect(result.plan.status).toBe("executed");
  expect(result.results.filter((item) => ids.includes(item.bookingId))).toEqual(ids.map((bookingId) => ({ bookingId, status: "VISIT_RETURNED" })));
  await executePlan(workspace.id, plan.id, repository);
  const returned = repository.latestMoneyEvents(workspace.id).filter((event) => event.status === "VISIT_RETURNED");
  expect(returned).toHaveLength(2);
  for (const event of returned) {
    expect(event).toMatchObject({ kind: "refund", amount: "0.00", paypalId: "", captureId: "", requestId: `${plan.id}:${event.bookingId}` });
    expect(await checkRefund(workspace.id, event.requestId, repository)).toEqual({ kind: "settled" });
    expect(await lookupRefund(event)).toEqual({ kind: "unknown" });
    expect(await reconcileRefund(event, repository)).toEqual({ kind: "unknown" });
    await withWorkspaceLock(repository, workspace.id, (owner) => executeRefund(workspace.id, plan.bookingActions.find((action) => action.bookingId === event.bookingId)!,
      event.requestId, repository, () => repository.renewLock(workspace.id, owner)));
    expect(repository.requireWorkspace(workspace.id).state.bookings.find((booking) => booking.id === event.bookingId)?.status).toBe("refunded");
  }
  expect(repository.listLedger(workspace.id).filter((event) => event.status === "VISIT_RETURNED")).toHaveLength(2);
  expect(await sweepRefunds(repository, workspace.id)).toBe(0);
  expect((await verifyWorkspaceMoney(workspace.id, repository)).summary.checked).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  const data = buildInsights(repository.requireWorkspace(workspace.id).state, repository.listPlans(workspace.id), repository.listLedger(workspace.id), repository.listCustomerLinks(workspace.id));
  expect(getRecoverySummary(data)).toMatchObject({ visitsReturned: 2, pending: 0, simulatedRefundAmount: Number(plan.totals.refundAmount) });
  expect(getRefundBreakdown(data, "status").rows.find((row) => row.label === "Visit Returned")).toMatchObject({ visitsReturned: 2, completedUSD: 0, simulatedUSD: 0 });
  expect(data.money_events.filter((row) => row.status === "VISIT_RETURNED").every((row) => row.issued_refund === 0 && row.net === 0 && row.payment_mode === "entitlement")).toBe(true);
  expect(recoveryMetric(data.money_events, "refunded").caption).toContain("2 visits returned");
  expect(data.money_events.filter((row) => row.status === "VISIT_RETURNED").every((row) => !row.display_amount.includes("$"))).toBe(true);
});

it.each([pack, membership])("gives %s customers a private cancellation and receipt without cash or credit", async (entitlement) => {
  const { workspace, plan, ids } = prepared(false);
  await executePlan(workspace.id, plan.id, repository);
  const bookingId = ids[entitlement.kind === "pack" ? 0 : 1];
  const link = repository.listCustomerLinks(workspace.id).find((item) => item.bookingId === bookingId)!;
  const token = repository.customerToken(link);
  const choice = await customerChoice(token, repository);
  expect(choice).toMatchObject({ entitlement, refundable: "0.00", canChoose: true });
  expect(choice.message.body).not.toMatch(/cash|credit|USD|PayPal|refund/i);
  expect(choice.alternatives.length).toBeGreaterThan(0);
  expect(choice.alternatives.every((session) => session.difference === "0.00")).toBe(true);
  await expect(submitChoice(token, { action: "credit" }, repository)).rejects.toMatchObject({ status: 409 });
  const result = await submitChoice(token, { action: "refund" }, repository);
  expect(result.receipt).toMatchObject({ status: "VISIT_RETURNED", amount: "0.00", paypalId: "" });
  await submitChoice(token, { action: "refund" }, repository);
  expect(repository.listLedger(workspace.id).filter((event) => event.bookingId === bookingId && event.status === "VISIT_RETURNED")).toHaveLength(1);
  expect(ownerCustomerChoices(workspace.id, repository).replies.find((reply) => reply.id === link.id)?.text).not.toMatch(/\$|cash|PayPal|credit/);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([pack, membership])("templates refund messages and guards assistant offers for %s", async (entitlement) => {
  const { workspace, state, plan, ids } = prepared(false);
  await executePlan(workspace.id, plan.id, repository);
  const bookingId = ids[entitlement.kind === "pack" ? 0 : 1];
  const link = repository.listCustomerLinks(workspace.id).find((item) => item.bookingId === bookingId)!;
  const token = repository.customerToken(link);
  ai.generateJson.mockResolvedValue({ data: { action: "refund", reply: "Here is $50 in cash" }, provider: "test", model: "test" });
  const proposal = await proposeChoice(token, "cancel please", repository);
  expect(proposal).toMatchObject({ action: "refund", refund: "0.00" });
  expect(proposal.reply).toContain(entitlementMessage(entitlement)); expect(proposal.reply).not.toMatch(/\$|cash|credit|PayPal/);
  expect(JSON.parse(ai.generateJson.mock.calls[0][0]).DATA.entitlement).toEqual(entitlement);
  ai.generateJson.mockResolvedValue({ data: { action: "credit", reply: "Have cash or credit" }, provider: "test", model: "test" });
  expect(await proposeChoice(token, "credit please", repository)).toMatchObject({ action: "clarify", refund: "0.00" });
  ai.generateJson.mockResolvedValue({ data: { action: "clarify", reply: "Would you like cash or credit?" }, provider: "test", model: "test" });
  expect((await proposeChoice(token, "?", repository)).reply).not.toMatch(/cash|credit|PayPal|refund/i);
  const message = draftCustomerMessages({ ...plan, bookingActions: [{ ...plan.bookingActions.find((action) => action.bookingId === bookingId)!, action: "refund" }] }, state)[0];
  expect(message.body).toContain(entitlementMessage(entitlement)); expect(message.body).not.toMatch(/\$|cash|credit|PayPal|USD/);
  expect(entitlementReceipt(entitlement)).not.toMatch(/\$|PayPal/);
});

it("moves an entitlement without adding a payment, price difference or visit return", async () => {
  const { workspace, plan, ids } = prepared(false);
  await executePlan(workspace.id, plan.id, repository);
  const link = repository.listCustomerLinks(workspace.id).find((item) => item.bookingId === ids[0])!;
  const token = repository.customerToken(link), choice = await customerChoice(token, repository);
  const moved = await submitChoice(token, { action: "move", sessionId: choice.alternatives[0].id }, repository);
  expect(moved.receipt).toBeUndefined();
  const booking = repository.requireWorkspace(workspace.id).state.bookings.find((item) => item.id === ids[0])!;
  expect(booking).toMatchObject({ status: "moved", amount: "0.00", entitlement: pack }); expect(booking.payment).toBeUndefined();
});

it.each([
  ["10 Class Pack", "pack"], ["CLASS PASS", "pack"], ["ClassPass", "pack"], ["20 credits", "pack"], ["5-class", "pack"], ["10 visit", "pack"],
  ["Membership", "membership"], ["Unlimited", "membership"], ["Monthly", "membership"], ["Annual", "membership"], ["Autopay", "membership"],
  ["", undefined], ["drop-in", undefined], ["single", undefined], ["card", undefined], ["cash", undefined], ["paypal", undefined],
])("classifies the pricing option %s", (value, kind) => {
  expect(paymentEntitlement(value)?.kind).toBe(kind);
  if (kind) expect(paymentEntitlement(`  ${value}  `)?.name).toBe(value);
});

it.each(["payment", "paymentmethod", "paidwith", "pricingoption", "pricing", "service", "pass", "membership"])("maps %s to Paid with", (header) => {
  expect(ruleMapping(["Class", header])).toMatchObject({ class: "Class", payment: header });
});

it("ignores an entitlement price cell and limits the pricing name to 60 characters", () => {
  const csv = `Class,Date,Start,Instructor,Client Email,Price,Paid with\nYoga,2026-11-02,09:00,Ana,a@example.com,not a price,  10 Class Pack ${"x".repeat(70)}  `;
  const imported = buildImport(csv, { mapping: ruleMapping(parseCsv(csv)[0]), classTypes: { Yoga: "yoga" }, timezone: "America/New_York" });
  expect(imported.errors).toEqual([]);
  expect(imported.state!.bookings[0]).toMatchObject({ amount: "0.00", entitlement: { kind: "pack" } });
  expect(imported.state!.bookings[0].entitlement!.name).toHaveLength(60);
  expect(imported.state!.bookings[0].payment).toBeUndefined();
});

it("imports the mixed sample week and returns visits when its instructor is sick, refunding only cash bookings", async () => {
  const csv = readFileSync(join(__dirname, "../public/samples/sample-week.csv"), "utf8");
  const input = { mapping: ruleMapping(parseCsv(csv)[0]), classTypes: { "Sunrise Reformer": "pilates", "Vinyasa Flow": "yoga", "Rhythm Ride": "spin", "Slow Burn": "yoga", "Strength Sculpt": "hiit", "Mat Pilates": "pilates" } as const, timezone: "America/New_York" };
  const imported = buildImport(csv, input);
  expect(imported.errors).toEqual([]); expect(imported.summary).toMatchObject({ classes: 15, bookings: 67, customers: 21 });
  expect(imported.warnings.join(" ")).toContain("12 bookings use a class pack and 11 a membership: Rebook returns visits instead of refunding cash. Imported pack balances and returned visits are tracked");
  const { id } = createImportedWorkspace(csv, input, repository);
  const state = repository.requireWorkspace(id).state;
  const entitlementBookings = state.bookings.filter((booking) => booking.entitlement);
  expect(entitlementBookings).toHaveLength(23);
  expect(entitlementBookings.every((booking) => booking.amount === "0.00" && !booking.payment)).toBe(true);
  expect(repository.listLedger(id)).toHaveLength(44);
  // These customers cannot take another placement; the sick teacher's affected class must cancel their bookings.
  const instructor = state.instructors.find((item) => item.name === "Ana Torres")!;
  const session = state.sessions.find((item) => item.instructorId === instructor.id)!;
  for (const customer of state.customers) customer.prefs.refundOnly = true;
  repository.saveState(id, state);
  const plan = repository.createPlan(id, replan(state, { kind: "instructor_unavailable", instructorId: instructor.id, from: session.start, to: session.end }));
  const result = await executePlan(id, plan.id, repository);
  expect(result.plan.status).toBe("executed");
  const returns = repository.latestMoneyEvents(id).filter((event) => event.status === "VISIT_RETURNED");
  expect(returns.length).toBeGreaterThan(0);
  expect(result.results.some((item) => item.status === "SIMULATED")).toBe(true);
  expect(new Set(returns.map((event) => state.bookings.find((booking) => booking.id === event.bookingId)!.entitlement!.kind))).toEqual(new Set(["pack", "membership"]));
  for (const event of repository.latestMoneyEvents(id).filter((event) => event.kind === "refund")) {
    const booking = state.bookings.find((item) => item.id === event.bookingId)!;
    expect(event.status).toBe(booking.entitlement ? "VISIT_RETURNED" : "SIMULATED");
    expect(event.amount).toBe(booking.amount);
  }
  expect(fetch).not.toHaveBeenCalled();
});
