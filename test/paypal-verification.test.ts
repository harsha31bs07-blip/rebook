import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { limits } from "../lib/api/limits";
import type { verifyWorkspaceMoney } from "../lib/paypal/verify";

const mock = vi.hoisted(() => ({ call: vi.fn(), construct: vi.fn() }));
vi.mock("@paypal/agent-toolkit/openai", () => ({ PayPalAgentToolkit: class {
  constructor(configuration: unknown) { mock.construct(configuration); }
  handleToolCall = mock.call;
} }));

let directory: string, repository: Repository, verify: typeof verifyWorkspaceMoney;
beforeEach(async () => {
  vi.resetModules(); mock.call.mockReset(); mock.construct.mockClear(); limits.reset();
  directory = mkdtempSync(join(tmpdir(), "rebook-verify-"));
  vi.stubEnv("DATA_DIR", directory); vi.stubEnv("PAYPAL_ENV", "sandbox");
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-id"); vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
  repository = getRepository();
  verify = (await import("../lib/paypal/verify")).verifyWorkspaceMoney;
  mock.call.mockImplementation(async (call) => ({ role: "tool", tool_call_id: call.id,
    content: JSON.stringify({ id: JSON.parse(call.function.arguments).refund_id, status: "COMPLETED", amount: { value: "25.00", currency_code: "USD" } }) }));
}, 30_000);
afterEach(() => {
  closeRepository(); rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks();
});

function fixture(count = 1, status = "COMPLETED") {
  const workspace = repository.createWorkspace(seedStudio());
  const events = Array.from({ length: count }, (_, index) => repository.appendLedger({ workspaceId: workspace.id,
    bookingId: workspace.state.bookings[index].id, kind: "refund", amount: "25.00", status,
    requestId: `request-${index}`, paypalId: `refund-${index}`, captureId: `capture-${index}` }));
  return { ...workspace, events };
}
function refund(body: unknown) { mock.call.mockResolvedValue({ role: "tool", content: JSON.stringify(body) }); }
function payout(id: string, status: "SUCCESS" | "PENDING" = "SUCCESS") {
  const { state } = repository.requireWorkspace(id);
  const plan = repository.createPlan(id, replan(state, demoDisruption));
  repository.saveCoverPayout({ workspaceId: id, planId: plan.id, sessionId: state.sessions[0].id, instructorId: state.instructors[1].id,
    amount: "35.00", status, batchId: "batch-1", requestId: "pay-1", attempt: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}
function payoutsFetch(status = "SUCCESS", value = "35.00", currency = "USD") {
  const fetch = vi.fn(async (url: string) => url.endsWith("/v1/oauth2/token")
    ? Response.json({ access_token: "test-token", expires_in: 3600 })
    : Response.json({ batch_header: { batch_status: "SUCCESS" }, items: [{ payout_item_id: "item-1", transaction_status: status,
      payout_item: { amount: { value, currency } } }] }));
  vi.stubGlobal("fetch", fetch); return fetch;
}

describe("read-only PayPal money verification", () => {
  it("matches latest refunds and a payout, reports names and sources, and never writes records", async () => {
    const { id, state, events } = fixture(2);
    repository.appendLedger({ ...events[0], status: "PENDING" });
    repository.appendLedger({ ...events[0], status: "COMPLETED" });
    payout(id);
    const ledger = repository.listLedger(id), payouts = repository.listCoverPayouts(id), workspace = repository.requireWorkspace(id);
    const append = vi.spyOn(repository, "appendLedger"), save = vi.spyOn(repository, "saveCoverPayout"), saveState = vi.spyOn(repository, "saveState");
    const fetch = payoutsFetch();
    const result = await verify(id, repository);
    expect(result.summary).toEqual({ checked: 3, matched: 3, mismatched: 0, unavailable: 0 });
    expect(result.items.map((row) => row.source)).toEqual(["PayPal Agent Toolkit", "PayPal Agent Toolkit", "Payouts API"]);
    const booking = state.bookings[0];
    expect(result.items[0].label).toContain(state.customers.find((row) => row.id === booking.customerId)!.name);
    expect(result.items[0].label).toContain(state.sessions.find((row) => row.id === booking.sessionId)!.title);
    expect(result.items[2].label).toContain(state.instructors[1].name);
    expect(mock.call).toHaveBeenCalledTimes(2);
    expect(mock.call.mock.calls.every(([call]) => call.type === "function" && call.function.name === "get_refund")).toBe(true);
    expect(fetch.mock.calls[1][0]).toBe("https://api-m.sandbox.paypal.com/v1/payments/payouts/batch-1");
    expect(append).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(saveState).not.toHaveBeenCalled();
    expect(repository.listLedger(id)).toEqual(ledger); expect(repository.listCoverPayouts(id)).toEqual(payouts); expect(repository.requireWorkspace(id)).toEqual(workspace);
    expect(Date.parse(result.checkedAt)).toBeGreaterThan(0);
  });

  it("constructs one toolkit with only the three correct read actions", async () => {
    const { id } = fixture(4);
    await verify(id, repository); await verify(id, repository);
    expect(mock.construct).toHaveBeenCalledTimes(1);
    expect(mock.construct.mock.calls[0][0]).toEqual({ clientId: "test-id", clientSecret: "test-secret", configuration: {
      actions: { payments: { getRefunds: true }, transactions: { list: true }, orders: { get: true } }, context: { sandbox: true, debug: false },
    } });
  });

  it.each([
    ["amount", { status: "COMPLETED", amount: { value: "24.99", currency_code: "USD" } }],
    ["currency", { status: "COMPLETED", amount: { value: "25.00", currency_code: "EUR" } }],
    ["status", { status: "PENDING", amount: { value: "25.00", currency_code: "USD" } }],
    ["refund identity", { id: "other-refund", status: "COMPLETED", amount: { value: "25.00", currency_code: "USD" } }],
  ])("flags a different %s", async (_name, body) => {
    const { id } = fixture(); refund(body);
    const result = await verify(id, repository);
    expect(result.items[0].match).toBe("mismatch"); expect(result.summary.mismatched).toBe(1);
  });

  it("accepts PayPal ahead only when the pending refund's money agrees", async () => {
    const { id } = fixture(1, "PENDING");
    expect((await verify(id, repository)).items[0].match).toBe("paypal-ahead");
    refund({ status: "COMPLETED", amount: { value: "26.00", currency_code: "USD" } });
    expect((await verify(id, repository)).items[0].match).toBe("mismatch");
  });

  it.each([{ status: 404, code: "PAYPAL_API_HTTP_ERROR" }, { name: "RESOURCE_NOT_FOUND" }, { error: { status: 404 } }])("recognizes toolkit not-found JSON %j", async (body) => {
    const { id } = fixture(); refund(body);
    const result = await verify(id, repository);
    expect(result.items[0]).toMatchObject({ paypal: "Not found", match: "not-found" }); expect(result.summary.mismatched).toBe(1);
  });

  it.each(["throw", "error-json", "malformed", "missing-money"])("turns %s into an unavailable check without exposing errors", async (mode) => {
    const { id } = fixture();
    if (mode === "throw") mock.call.mockRejectedValue(new Error("secret upstream detail"));
    if (mode === "error-json") refund({ error: { message: "secret upstream detail", type: "paypal_error" } });
    if (mode === "malformed") mock.call.mockResolvedValue({ content: "not JSON" });
    if (mode === "missing-money") refund({ status: "COMPLETED" });
    const result = await verify(id, repository);
    expect(result.items[0].match).toBe("unavailable"); expect(result.summary.unavailable).toBe(1);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it.each(["SIMULATED", "REQUESTED", "FAILED", "UNKNOWN"])("skips %s refunds and does not load the toolkit", async (status) => {
    const { id } = fixture(1, status);
    expect((await verify(id, repository)).summary.checked).toBe(0); expect(mock.construct).not.toHaveBeenCalled();
  });

  it("skips refunds without a PayPal ID and payouts without a batch ID", async () => {
    const { id, events } = fixture(); repository.appendLedger({ ...events[0], paypalId: "" }); payout(id);
    const [record] = repository.listCoverPayouts(id); repository.saveCoverPayout({ ...record, batchId: undefined });
    expect((await verify(id, repository)).items).toEqual([]); expect(mock.construct).not.toHaveBeenCalled();
  });

  it.each(["live", "missing-credentials"])("fails closed for %s", async (mode) => {
    const { id } = fixture();
    if (mode === "live") vi.stubEnv("PAYPAL_ENV", "live"); else vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
    expect((await verify(id, repository)).summary.unavailable).toBe(1); expect(mock.construct).not.toHaveBeenCalled();
  });

  it.each([["SUCCESS", "35.00", "USD", "match"], ["SUCCESS", "34.00", "USD", "mismatch"],
    ["SUCCESS", "35.00", "EUR", "mismatch"], ["PENDING", "35.00", "USD", "mismatch"]])("checks payout item %s %s %s", async (status, value, currency, match) => {
    const { id } = fixture(0); payout(id); payoutsFetch(status, value, currency);
    expect((await verify(id, repository)).items[0].match).toBe(match);
  });

  it("reports a completed pending payout as PayPal ahead", async () => {
    const { id } = fixture(0); payout(id, "PENDING"); payoutsFetch();
    expect((await verify(id, repository)).items[0].match).toBe("paypal-ahead");
  });

  it("does not treat a successful payout batch or an item without money as verified", async () => {
    const { id } = fixture(0); payout(id);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/token") ? Response.json({ access_token: "test", expires_in: 3600 })
      : Response.json({ batch_header: { batch_status: "SUCCESS" }, items: [{ transaction_status: "SUCCESS" }] })));
    expect((await verify(id, repository)).items[0].match).toBe("unavailable");
  });

  it("reports a missing payout as not found and a fetch failure as unavailable", async () => {
    const { id } = fixture(0); payout(id);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/token") ? Response.json({ access_token: "test", expires_in: 3600 }) : Response.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 })));
    expect((await verify(id, repository)).items[0].match).toBe("not-found");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    expect((await verify(id, repository)).items[0].match).toBe("unavailable"); log.mockRestore();
  });

  it("times out at 10 seconds without launching more than three unabortable calls or changing returned results later", async () => {
    vi.useFakeTimers(); const { id } = fixture(8);
    let release!: (value: unknown) => void;
    mock.call.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const pending = verify(id, repository); await vi.advanceTimersByTimeAsync(9_999);
    expect(mock.call).toHaveBeenCalledTimes(3);
    let finished = false; void pending.then(() => { finished = true; }); expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.summary).toEqual({ checked: 8, matched: 0, mismatched: 0, unavailable: 8 });
    release({ content: JSON.stringify({ status: "COMPLETED", amount: { value: "25.00", currency_code: "USD" } }) });
    await vi.advanceTimersByTimeAsync(30_000); expect(result.summary.unavailable).toBe(8); expect(mock.call).toHaveBeenCalledTimes(3);
  });

  it("keeps timed-out calls counted across runs, so later runs never add upstream calls beyond three", async () => {
    vi.useFakeTimers(); const { id } = fixture(4);
    const releases: ((value: unknown) => void)[] = [];
    mock.call.mockImplementation(() => new Promise((resolve) => { releases.push(resolve); }));
    for (let run = 0; run < 3; run++) {
      const pending = verify(id, repository); await vi.advanceTimersByTimeAsync(10_000);
      expect((await pending).summary.unavailable).toBe(4);
    }
    expect(mock.call).toHaveBeenCalledTimes(3);
    const body = { content: JSON.stringify({ status: "COMPLETED", amount: { value: "25.00", currency_code: "USD" } }) };
    releases.splice(0).forEach((release) => release(body)); await vi.advanceTimersByTimeAsync(0);
    mock.call.mockResolvedValue(body);
    expect((await verify(id, repository)).summary.matched).toBe(4);
  });

  it("bounds a long queue to the 30-second whole-call budget", async () => {
    vi.useFakeTimers(); const { id } = fixture(15); let active = 0, peak = 0;
    mock.call.mockImplementation(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 9_000)); active--;
      return { content: JSON.stringify({ status: "COMPLETED", amount: { value: "25.00", currency_code: "USD" } }) };
    });
    const start = Date.now(), pending = verify(id, repository);
    await vi.advanceTimersByTimeAsync(30_000); const result = await pending;
    expect(Date.now() - start).toBe(30_000); expect(peak).toBe(3); expect(mock.call).toHaveBeenCalledTimes(12);
    expect(result.summary).toEqual({ checked: 15, matched: 9, mismatched: 0, unavailable: 6 });
  });
});

describe("verification route", () => {
  async function route() { return (await import("../app/api/workspaces/[id]/verify/route")).POST; }
  function request(id: string, origin = "https://studio.test") {
    return new Request(`https://studio.test/api/workspaces/${id}/verify`, { method: "POST", headers: { origin } });
  }
  it("rejects cross-origin requests before reading PayPal", async () => {
    const { id } = fixture(), POST = await route();
    expect((await POST(request(id, "https://elsewhere.test"), { params: Promise.resolve({ id }) })).status).toBe(403);
    expect(mock.call).not.toHaveBeenCalled();
  });
  it("shares concurrent requests and cached results for 30 seconds, then refreshes", async () => {
    vi.useFakeTimers(); const { id } = fixture(), POST = await route(), context = { params: Promise.resolve({ id }) };
    const [first, second] = await Promise.all([POST(request(id), context), POST(request(id), context)]);
    expect(first.status).toBe(200); expect(first.headers.get("Cache-Control")).toBe("no-store");
    const original = await first.json(); expect(await second.json()).toEqual(original); expect(mock.call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_001);
    const refreshed = await POST(request(id), context); expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).checkedAt).not.toBe(original.checkedAt); expect(mock.call).toHaveBeenCalledTimes(2);
  });
  it("limits even cached requests to three per minute, independently per workspace", async () => {
    vi.useFakeTimers(); const { id } = fixture(), POST = await route(), context = { params: Promise.resolve({ id }) };
    for (let index = 0; index < 3; index++) expect((await POST(request(id), context)).status).toBe(200);
    const limited = await POST(request(id), context); expect(limited.status).toBe(429); expect(limited.headers.get("Retry-After")).toBe("60");
    const other = fixture(); expect((await POST(request(other.id), { params: Promise.resolve({ id: other.id }) })).status).toBe(200);
    expect(mock.call).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000); expect((await POST(request(id), context)).status).toBe(200);
  });
  it("returns unavailable checks with 200 when the toolkit fails", async () => {
    const { id } = fixture(), POST = await route(); mock.call.mockRejectedValue(new Error("upstream failed"));
    const response = await POST(request(id), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200); expect((await response.json()).summary.unavailable).toBe(1);
  });
  it("requires an existing ready workspace even when a result was cached", async () => {
    const { id } = fixture(), POST = await route(), context = { params: Promise.resolve({ id }) };
    expect((await POST(request(id), context)).status).toBe(200);
    repository.updatePreparation(id, "preparing", { done: 0, total: 1 });
    expect((await POST(request(id), context)).status).toBe(409);
    expect((await POST(request("missing123"), { params: Promise.resolve({ id: "missing123" }) })).status).toBe(404);
  });
});
