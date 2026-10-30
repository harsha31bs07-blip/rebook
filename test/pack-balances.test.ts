import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { BookingSchema } from "../lib/domain/schemas";
import { packBalance, packReturnBalance, plannedPackBalances } from "../lib/domain/pack-balances";
import { packBalanceCsv } from "../lib/domain/pack-balance-export";
import { entitlementLabel, entitlementMessage, entitlementReceipt } from "../lib/domain/entitlements";
import { buildImport } from "../lib/import/build";
import { ruleMapping } from "../lib/import/fields";
import { parseCsv } from "../lib/import/csv";
import { createImportedWorkspace } from "../lib/import/service";
import { closeRepository, getRepository, type LedgerEvent } from "../lib/store";
import { replan } from "../lib/solver/replan";
import { executePlan } from "../lib/executor/executePlan";
import { draftCustomerMessages } from "../lib/ai/messages";
import { customerChoice, ownerCustomerChoices, submitChoice } from "../lib/choices/service";
import { exportPackBalances } from "../lib/export/pack-balances";
import { GET } from "../app/api/workspaces/[id]/pack-balances/route";
import { limits } from "../lib/api/limits";
import type { Booking } from "../lib/domain/types";
import { buildInsights } from "../lib/insights/data";

let directory: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "rebook-pack-balances-")); vi.stubEnv("DATA_DIR", directory); limits.reset();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected PayPal request"); }));
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function returned(bookingId: string, requestId = bookingId): LedgerEvent {
  return { id: requestId, workspaceId: "workspace", bookingId, requestId, kind: "refund", amount: "0.00", paypalId: "", captureId: "", status: "VISIT_RETURNED", createdAt: new Date().toISOString() };
}
const pack = { kind: "pack", name: "10 Class Pack", visitsLeft: 3, expires: "2026-11-20" } as const;
function input(csv: string) { return { mapping: ruleMapping(parseCsv(csv)[0]), classTypes: { Yoga: "yoga" as const }, timezone: "America/New_York" }; }
const csv = (visits: string, expires = "11/20/2026", pricing = "10 Class Pack") => `Class,Date,Start,Instructor,Client Email,Pricing Option,Visits Left,Expiry\nYoga,2026-11-09,09:00,Ana,a@example.com,${pricing},${visits},${expires}`;

it("uses the lowest imported snapshot, counts returns once, and separates customer packs", () => {
  const state = seedStudio(), first = state.bookings[0];
  const second: Booking = { ...first, id: "second", entitlement: { ...pack, visitsLeft: 7 } };
  first.entitlement = { ...pack };
  state.bookings.push(second, { ...first, id: "other-pack", entitlement: { ...pack, name: "5 Class Pack", visitsLeft: 1 } });
  const ledger = [returned(first.id), returned(first.id), returned("other-pack"), { ...returned(second.id), status: "REQUESTED" }];
  expect(packBalance(state, ledger, first.customerId, pack.name)).toBe(4);
  expect(packBalance(state, ledger, first.customerId, "5 Class Pack")).toBe(2);
  expect(packBalance(state, ledger, "other-customer", pack.name)).toBeNull();
  expect(packBalance(state, ledger, first.customerId, "Unknown")).toBeNull();
  expect(packReturnBalance(state, ledger, first)).toEqual({ before: 3, after: 4 });
  delete first.entitlement.visitsLeft;
  delete second.entitlement!.visitsLeft;
  expect(packBalance(state, ledger, first.customerId, pack.name)).toBeNull();
});

it("validates optional balance fields and keeps old entitlement records valid", () => {
  const booking = { ...seedStudio().bookings[0], payment: undefined, amount: "0.00" };
  expect(BookingSchema.safeParse({ ...booking, entitlement: pack }).success).toBe(true);
  expect(BookingSchema.safeParse({ ...booking, entitlement: { kind: "pack", name: "Old pack" } }).success).toBe(true);
  for (const entitlement of [{ ...pack, visitsLeft: -1 }, { ...pack, visitsLeft: 1.2 }, { ...pack, kind: "membership" }, { ...pack, expires: "2026-02-30" }]) {
    expect(BookingSchema.safeParse({ ...booking, entitlement }).success).toBe(false);
  }
});

it.each(["0", "3", "003"])("imports visits left %s and supported expiry dates", (visits) => {
  for (const expires of ["11/20/2026", "20/11/2026", "2026-11-20", "20 Nov 2026", "Nov 20 2026"]) {
    const text = csv(visits, expires), result = buildImport(text, input(text));
    expect(result.errors).toEqual([]);
    expect(result.state!.bookings[0].entitlement).toEqual({ ...pack, visitsLeft: Number(visits) });
  }
});
it.each(["-1", "1.5", "three", "+2", "1e2", "9007199254740992"])("rejects invalid pack balance %s with its row number", (visits) => {
  const text = csv(visits), result = buildImport(text, input(text));
  expect(result.errors).toContain(`Row 2: Visits left must be a non-negative integer, not "${visits}".`);
  expect(result.state).toBeUndefined();
});
it("rejects invalid expiry and respects the import date order", () => {
  const invalid = csv("3", "2026-02-30");
  expect(buildImport(invalid, input(invalid)).errors[0]).toContain("Row 2: can't read the pack expiry");
  const text = csv("3", "12/11/2026");
  expect(buildImport(text, { ...input(text), dateOrder: "dmy" }).state!.bookings[0].entitlement?.expires).toBe("2026-11-12");
});
it("maps all balance and expiry synonyms", () => {
  for (const header of ["visitsleft", "remaining", "remainingvisits", "classesleft", "creditsleft", "sessionsremaining", "balance"]) expect(ruleMapping([header]).visitsLeft).toBe(header);
  for (const header of ["expires", "expiry", "expiration", "expirationdate", "validuntil"]) expect(ruleMapping([header]).expires).toBe(header);
});
it("keeps the original import warning when a pack balance is unknown", () => {
  const text = csv("", ""), result = buildImport(text, input(text));
  expect(result.errors).toEqual([]);
  expect(result.warnings).toContain("1 bookings use a class pack and 0 a membership: Rebook returns visits instead of refunding cash, and your booking system keeps the balances.");
});
it.each(["cash", "Unlimited Monthly"])("ignores pack fields on %s rows with one warning", (pricing) => {
  const text = csv("bad", "bad", pricing), result = buildImport(text + "\n" + text.split("\n")[1], input(text));
  expect(result.errors).toEqual([]);
  expect(result.warnings.filter((warning) => warning.includes("were ignored"))).toHaveLength(1);
  expect(result.state!.bookings[0].entitlement?.visitsLeft).toBeUndefined();
  expect(result.state!.bookings[0].entitlement?.expires).toBeUndefined();
});

it("uses known balances in messages and receipts, with a studio-local 14-day expiry note", () => {
  const start = "2026-11-07T00:30:00Z";
  expect(entitlementMessage(pack, 3, start, "America/New_York")).toBe("We'll return the visit to your 10 Class Pack (you'll have 4 visits left). It expires on Nov 20.");
  expect(entitlementReceipt(pack, 4, start, "America/New_York")).toBe("Visit returned to your 10 Class Pack · 4 visits left. It expires on Nov 20.");
  expect(entitlementMessage(pack, 3, "2026-11-05T12:00:00Z")).not.toContain("expires");
  expect(entitlementMessage(pack, 3, "2026-11-21T12:00:00Z")).not.toContain("expires");
  expect(entitlementMessage(pack)).toBe("We'll return the visit to your 10 Class Pack.");
  expect(entitlementReceipt(pack)).toBe("Visit returned to your 10 Class Pack");
  expect(entitlementLabel(pack, { before: 3, after: 4 })).toBe("Returns 1 visit · 10 Class Pack · 3 → 4 left");
});

it("exports all sample pack returns after approval, including class details removed from the live schedule", async () => {
  const repository = getRepository(), text = readFileSync(join(__dirname, "../public/samples/sample-week.csv"), "utf8");
  const options = { mapping: ruleMapping(parseCsv(text)[0]), classTypes: { "Sunrise Reformer": "pilates", "Vinyasa Flow": "yoga", "Rhythm Ride": "spin", "Slow Burn": "yoga", "Strength Sculpt": "hiit", "Mat Pilates": "pilates" } as const, timezone: "America/New_York" };
  const imported = buildImport(text, options);
  expect(imported.errors).toEqual([]); expect(imported.summary).toMatchObject({ classes: 15, bookings: 67, customers: 21 });
  const { id } = createImportedWorkspace(text, options, repository), state = repository.requireWorkspace(id).state;
  for (const customer of state.customers) customer.prefs.refundOnly = true;
  const instructorId = state.instructors.find((item) => item.name === "Ana Torres")!.id;
  repository.saveState(id, state);
  const plan = repository.createPlan(id, replan(state, { kind: "instructor_unavailable", instructorId, from: state.studio.weekStart, to: "2026-11-09T05:00:00Z" }));
  const preview = draftCustomerMessages(plan, state);
  expect(preview.some((message) => message.body.includes("visits left"))).toBe(true);
  await executePlan(id, plan.id, repository);
  const ledger = repository.listLedger(id), rows = parseCsv(exportPackBalances(id, repository));
  const returnedPacks = ledger.filter((event) => event.status === "VISIT_RETURNED" && state.bookings.find((booking) => booking.id === event.bookingId)?.entitlement?.kind === "pack");
  expect(returnedPacks.length).toBeGreaterThan(1); expect(rows).toHaveLength(returnedPacks.length + 1);
  for (const row of rows.slice(1)) { expect(row[3]).not.toBe(""); expect(row[4]).toMatch(/^2026-11-\d\d \d\d:\d\d$/); expect(+row[7]).toBe(+row[6] + 1); }
  const first = state.bookings.find((booking) => booking.id === returnedPacks[0].bookingId)!;
  expect(packBalance(repository.requireWorkspace(id).state, ledger, first.customerId, first.entitlement!.name)).toBe(+rows[1][7]);
  const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200); expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="pack-balances-2026-10-29.csv"');
  expect(await response.text()).toBe(exportPackBalances(id, repository));
  expect(fetch).not.toHaveBeenCalled();
});

it("exports later customer-choice returns and updates the view without mutating imported balances", async () => {
  const repository = getRepository(), state = seedStudio();
  const candidate = replan(state, demoDisruption).bookingActions.find((action) => action.action === "move")!;
  const booking = state.bookings.find((item) => item.id === candidate.bookingId)!;
  booking.entitlement = pack; booking.amount = "0.00"; delete booking.payment;
  for (const item of state.bookings) if (item.payment) item.payment.simulated = true;
  const { id } = repository.createWorkspace(state);
  const plan = repository.createPlan(id, replan(state, demoDisruption));
  await executePlan(id, plan.id, repository);
  const link = repository.listCustomerLinks(id).find((item) => item.bookingId === booking.id)!;
  const token = repository.customerToken(link);
  expect((await customerChoice(token, repository)).packBalance).toBe(3);
  expect(parseCsv(exportPackBalances(id, repository))).toHaveLength(1);
  const choice = await submitChoice(token, { action: "refund" }, repository);
  expect(choice.packBalance).toBe(4); expect(choice.entitlement?.visitsLeft).toBe(3);
  expect(choice.receipt?.status).toBe("VISIT_RETURNED");
  await submitChoice(token, { action: "refund" }, repository);
  expect(parseCsv(exportPackBalances(id, repository))[1].slice(6, 8)).toEqual(["3", "4"]);
  expect(parseCsv(exportPackBalances(id, repository))).toHaveLength(2);
  expect(ownerCustomerChoices(id, repository).outbox.flatMap((row) => row.changes).find((change) => change.bookingId === booking.id)?.packBalance).toEqual({ before: 3, after: 4 });
  const data = buildInsights(repository.requireWorkspace(id).state, repository.listPlans(id), repository.listLedger(id));
  expect(data.bookings.find((item) => item.id === booking.id)?.pack_balance).toBe(4);
  expect(data.money_events.find((event) => event.booking_id === booking.id)).toMatchObject({ visits_returned: 1, amount: 0, issued_refund: 0, net: 0 });
  // Pack return history remains available when a busy workspace's last 500 money rows no longer include it.
  const cash = state.bookings.find((item) => item.payment)!;
  for (let index = 0; index < 501; index++) repository.appendLedger({ workspaceId: id, bookingId: cash.id, kind: "capture", amount: "0.00", paypalId: `history-${index}`, captureId: `history-${index}`, requestId: `history-${index}`, status: "SIMULATED" });
  expect(repository.listLedger(id, 500).some((event) => event.bookingId === booking.id)).toBe(false);
  expect(ownerCustomerChoices(id, repository).packReturns?.map((event) => event.bookingId)).toContain(booking.id);
});

it("escapes commas, quotes, newlines and formula prefixes, and leaves unknown balances blank", () => {
  const state = seedStudio(), booking = state.bookings[0], customer = state.customers.find((item) => item.id === booking.customerId)!;
  booking.entitlement = { kind: "pack", name: '@Pack, "ten"\nvisits' };
  customer.name = '=SUM(1,2)'; customer.email = '+a@example.com'; state.sessions.find((item) => item.id === booking.sessionId)!.title = '-Yoga';
  const text = packBalanceCsv(state, [returned(booking.id)]), rows = parseCsv(text);
  expect(rows[0]).toEqual(["Customer", "Email", "Pack", "Class", "Class start (studio local)", "Returned at", "Balance before", "Balance after", "Expires"]);
  expect(rows[1].slice(0, 4)).toEqual(["'=SUM(1,2)", "'+a@example.com", '\'@Pack, "ten"\nvisits', "'-Yoga"]);
  expect(rows[1].slice(6, 9)).toEqual(["", "", ""]);
});

it("sequences multiple planned and completed returns without counting them twice", () => {
  const state = seedStudio(), first = state.bookings[0]; first.entitlement = pack;
  const second = { ...first, id: "second" }; state.bookings.push(second);
  const plan = { ...replan(state, demoDisruption), bookingActions: [first, second].map((booking) => ({ bookingId: booking.id, customerId: booking.customerId, action: "refund" as const, amount: "0.00", reason: "Cancelled" })) };
  expect([...plannedPackBalances(state, [], plan).values()]).toEqual([{ before: 3, after: 4 }, { before: 4, after: 5 }]);
  const ledger = [returned(first.id), returned(second.id)];
  expect([...plannedPackBalances(state, ledger, plan).values()]).toEqual([{ before: 3, after: 4 }, { before: 4, after: 5 }]);
});

it("returns 404 for unknown workspaces and rate limits CSV downloads", async () => {
  const missing = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: "abcdefghij" }) });
  expect(missing.status).toBe(404);
  const { id } = getRepository().createWorkspace(seedStudio());
  for (let index = 0; index < 10; index++) expect((await GET(new Request("http://localhost"), { params: Promise.resolve({ id }) })).status).toBe(200);
  expect((await GET(new Request("http://localhost"), { params: Promise.resolve({ id }) })).status).toBe(429);
});
