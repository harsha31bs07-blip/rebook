import { setSdkTransport } from "./paypalTransport";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as approve } from "../app/api/workspaces/[id]/plans/[planId]/approve/route";
import { resetWorkspace } from "../lib/demo/createWorkspace";
import { executePlan } from "../lib/executor/executePlan";
import { POST as reset } from "../app/api/workspaces/[id]/reset/route";
import { lookupRefund } from "../lib/executor/reconcileRefund";
import { limits } from "../lib/api/limits";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { closeRepository, getRepository, type Repository } from "../lib/store";

let directory: string, repository: Repository;
beforeEach(() => {
  limits.reset();
  directory = mkdtempSync(join(tmpdir(), "rebook-recovery-"));
  vi.stubEnv("DATA_DIR", directory); vi.stubEnv("DEMO_REAL_CAPTURES", "0");
  vi.stubEnv("PAYPAL_ENV", "sandbox"); vi.stubEnv("PAYPAL_CLIENT_ID", randomUUID()); vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
  vi.spyOn(console, "error").mockImplementation(() => {});
  repository = getRepository();
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function prepared() {
  const state = seedStudio();
  for (const booking of state.bookings) booking.payment!.simulated = false;
  const workspace = repository.createWorkspace(state);
  for (const booking of state.bookings) repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id,
    kind: "capture", amount: booking.amount, paypalId: booking.payment!.captureId, captureId: booking.payment!.captureId,
    requestId: `${workspace.id}${booking.id}`, status: "COMPLETED" });
  const plan = repository.createPlan(workspace.id, replan(state, demoDisruption));
  const refunds = plan.bookingActions.filter((action) => action.action === "refund");
  const context = { params: Promise.resolve({ id: workspace.id, planId: plan.id }) };
  const request = () => new Request("http://localhost/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return { workspace, plan, refunds, context, request };
}
function transport(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const send = vi.fn(async (url: string, init: RequestInit) => url.endsWith("/token")
    ? Response.json({ access_token: "token", token_type: "Bearer", expires_in: 3600 }) : handler(url, init));
  setSdkTransport(send);
  return send;
}

describe("refund recovery via mocked SDK transport", () => {
  it.each(["invoice_id"])("reconciles a timed-out refund by %s without a second refund POST", async (field) => {
    const { workspace, plan, refunds } = prepared();
    const byCapture = new Map<string, { id: string; status: string; amount: { currency_code: string; value: string }; [key: string]: unknown }>();
    let resume = false;
    const send = transport(async (url, init) => {
      if (init.method === "GET") return Response.json({ id: url.split("/").at(-1), status: "REFUNDED", refunds: [byCapture.get(url.split("/").at(-1)!)!] });
      const captureId = url.split("/").at(-2)!;
      const requestId = (init.headers as Record<string, string>)["PayPal-Request-Id"];
      const body = JSON.parse(init.body as string);
      byCapture.set(captureId, { id: `refund-${captureId}`, status: "COMPLETED", amount: body.amount, [field]: requestId });
      if (!resume) throw new Error("Transport timeout after PayPal accepted refund");
      throw new Error("Unexpected second refund");
    });
    const first = await executePlan(workspace.id, plan.id, repository);
    expect(first.plan.status).toBe("partially_failed");
    expect(first.results.every((result) => result.status === "REQUESTED")).toBe(true);
    resume = true;
    const second = await executePlan(workspace.id, plan.id, repository);
    expect(second.plan.status).toBe("executed");
    expect(second.results.every((result) => result.status === "COMPLETED")).toBe(true);
    expect(send.mock.calls.filter(([url]) => url.endsWith("/refund"))).toHaveLength(refunds.length);
  });

  it("retries still-unknown requests with their original idempotency keys", async () => {
    const { workspace, plan, refunds } = prepared();
    let resume = false;
    const keys: string[] = [];
    transport(async (url, init) => {
      if (init.method === "GET") throw new Error("Reconciliation unavailable");
      const key = (init.headers as Record<string, string>)["PayPal-Request-Id"];
      keys.push(key);
      if (!resume) throw new Error("Transport timeout");
      return Response.json({ id: `refund-${key}`, status: "COMPLETED" }, { status: 201 });
    });
    await executePlan(workspace.id, plan.id, repository);
    resume = true;
    const result = await executePlan(workspace.id, plan.id, repository);
    expect(result.plan.status).toBe("executed");
    for (const action of refunds) expect(keys.filter((key) => key === `${plan.id}:${action.bookingId}`)).toHaveLength(2);
  });

  it("reconciles known refund IDs directly through SDK GET refund", async () => {
    const { workspace, plan, refunds } = prepared();
    transport(async () => { throw new Error("Transport timeout"); });
    await executePlan(workspace.id, plan.id, repository);
    for (const event of repository.latestMoneyEvents(workspace.id).filter((item) => item.kind === "refund")) {
      repository.appendLedger({ ...event, paypalId: `known-${event.bookingId}` });
    }
    const send = transport(async (url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/payments/refunds/");
      const event = repository.latestMoneyEvents(workspace.id).find((item) => item.paypalId === url.split("/").at(-1))!;
      return Response.json({ id: event.paypalId, status: "COMPLETED", amount: { currency_code: "USD", value: event.amount } });
    });
    const result = await executePlan(workspace.id, plan.id, repository);
    expect(result.results.every((item) => item.status === "COMPLETED")).toBe(true);
    expect(send.mock.calls.filter(([url]) => url.includes("/payments/refunds/"))).toHaveLength(refunds.length);
  });

  it("follows capture refund references through the SDK and matches invoice IDs", async () => {
    const { workspace, plan } = prepared();
    transport(async () => { throw new Error("Transport timeout"); });
    await executePlan(workspace.id, plan.id, repository);
    const events = repository.latestMoneyEvents(workspace.id).filter((item) => item.kind === "refund");
    const send = transport(async (url, init) => {
      expect(init.method).toBe("GET");
      const id = url.split("/").at(-1)!;
      if (url.includes("/captures/")) return Response.json({ id, status: "REFUNDED", links: [
        { rel: "refund", href: `https://api-m.sandbox.paypal.com/v2/payments/refunds/refund-${id}`, method: "GET" },
      ] });
      const event = events.find((item) => `refund-${item.captureId}` === id)!;
      return Response.json({ id, status: "COMPLETED", invoice_id: event.requestId, amount: { currency_code: "USD", value: event.amount } });
    });
    const result = await executePlan(workspace.id, plan.id, repository);
    expect(result.plan.status).toBe("executed");
    expect(send.mock.calls.some(([url]) => url.endsWith("/refund"))).toBe(false);
  });

  it("retries a rejected 4xx refund through approve only after checking the capture", async () => {
    const { workspace, plan, refunds, context, request } = prepared();
    let retry = false;
    const send = transport(async (url, init) => {
      if (init.method === "GET") return Response.json({ id: url.split("/").at(-1), status: "COMPLETED" });
      return retry ? Response.json({ id: `refund-${url.split("/").at(-2)}`, status: "COMPLETED" }, { status: 201 })
        : Response.json({ name: "UNPROCESSABLE_ENTITY", message: "Refund was rejected" }, { status: 422 });
    });
    const first = await (await approve(request(), context)).json();
    expect(first.plan.status).toBe("partially_failed");
    expect(first.results.every((item: { error: string }) => item.error.includes("Refund was rejected"))).toBe(true);
    retry = true;
    const second = await (await approve(request(), context)).json();
    expect(second.plan.status).toBe("executed");
    const posts = send.mock.calls.filter(([url]) => url.endsWith("/refund"));
    expect(posts).toHaveLength(refunds.length * 2);
    expect(send.mock.calls.filter(([, init]) => init.method === "GET")).toHaveLength(refunds.length);
    expect(repository.ledgerSummary(workspace.id).refunded).toBe(plan.totals.refundAmount);
    const firstKeys = posts.slice(0, refunds.length).map(([, init]) => (init.headers as Record<string, string>)["PayPal-Request-Id"]);
    expect(posts.slice(refunds.length).map(([, init]) => (init.headers as Record<string, string>)["PayPal-Request-Id"])).toEqual(firstKeys);
  });

  it("does not retry a FAILED request when reconciliation cannot prove absence", async () => {
    const { workspace, plan } = prepared();
    const send = transport(async (url, init) => init.method === "GET"
      ? Response.json({ id: url.split("/").at(-1), status: "PARTIALLY_REFUNDED" })
      : Response.json({ name: "UNPROCESSABLE_ENTITY", message: "Declined" }, { status: 422 }));
    await executePlan(workspace.id, plan.id, repository);
    send.mockClear();
    const result = await executePlan(workspace.id, plan.id, repository);
    expect(result.plan.status).toBe("partially_failed");
    expect(send.mock.calls.every(([, init]) => init.method === "GET" || String(init.body).includes("grant_type"))).toBe(true);
  });

  it("locks concurrent approve calls so each booking has one refund", async () => {
    const { workspace, refunds, context, request } = prepared();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const send = transport(async (url) => { entered(); await gate; return Response.json({ id: `refund-${url.split("/").at(-2)}`, status: "COMPLETED" }); });
    const first = approve(request(), context);
    await started;
    const second = await approve(request(), context);
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(send.mock.calls.filter(([url]) => url.endsWith("/refund"))).toHaveLength(refunds.length);
    expect(repository.latestMoneyEvents(workspace.id).filter((event) => event.kind === "refund")).toHaveLength(refunds.length);
  });

  it("rejects reset without destroying recovery, then permits it after reconciliation", async () => {
    const { workspace, plan } = prepared();
    transport(async () => { throw new Error("Transport timeout"); });
    await executePlan(workspace.id, plan.id, repository);
    const old = repository.listLedger(workspace.id);
    const denied = await reset(new Request("http://localhost/reset", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: workspace.id }) });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: "Finish or retry pending refunds first" });
    expect(repository.listLedger(workspace.id)).toEqual(old);
    expect(repository.getPlan(workspace.id, plan.id)).toBeDefined();
    const refunds = repository.latestMoneyEvents(workspace.id).filter((event) => event.kind === "refund");
    transport(async (url) => {
      const event = refunds.find((event) => url.endsWith(event.captureId))!;
      return Response.json({ id: event.captureId, status: "REFUNDED", refunds: [{ id: `refund-${event.bookingId}`, status: "COMPLETED", invoice_id: event.requestId, amount: { currency_code: "USD", value: event.amount } }] });
    });
    const fresh = await resetWorkspace(workspace.id, { repository });
    expect(fresh.status).toBe("ready");
    expect(repository.listLedger(workspace.id).slice(0, old.length)).toEqual(old);
    expect(repository.listPlans(workspace.id)).toEqual([]);
    expect(fresh.state.bookings.some((booking) => booking.id === refunds[0].bookingId)).toBe(false);
  });

  it.each(["PENDING", "REQUESTED"])("rejects reset with an unresolved capture (%s)", async (status) => {
    const { workspace } = prepared();
    const capture = repository.latestMoneyEvents(workspace.id)[0];
    repository.appendLedger({ ...capture, status });
    await expect(resetWorkspace(workspace.id, { repository })).rejects.toMatchObject({ status: 409, message: "Finish or retry pending refunds first" });
  });

  it("rejects reset with an interrupted execution even before its first refund reservation", async () => {
    const { workspace, plan } = prepared();
    repository.savePlan({ ...plan, status: "executing", basis: workspace.state });
    await expect(resetWorkspace(workspace.id, { repository })).rejects.toMatchObject({ status: 409 });
    expect(repository.getPlan(workspace.id, plan.id)?.status).toBe("executing");
  });

  it("rejects reset while a customer checkout capture is unresolved", async () => {
    const { workspace } = prepared();
    const session = workspace.state.sessions[0];
    const checkout = { id: "buyer", workspaceId: workspace.id, requestId: "buyer-key", sessionId: session.id,
      customer: { name: "Buyer", email: "buyer@example.com" }, amount: "10.00", currency: "USD" as const,
      session, expiresAt: Date.now() - 1, orderId: "buyer-order", status: "capturing" as const };
    repository.saveCheckout(checkout);
    await expect(resetWorkspace(workspace.id, { repository })).rejects.toMatchObject({ status: 409, message: "Finish or retry pending refunds first" });
    expect(repository.listCheckout(workspace.id)).toEqual([checkout]);
    expect(repository.requireWorkspace(workspace.id).state).toEqual(workspace.state);
  });

  it("returns the friendly reset conflict while an execution owns the workspace lease", async () => {
    const { workspace, plan } = prepared();
    repository.savePlan({ ...plan, status: "executing", basis: workspace.state });
    const owner = repository.acquireLock(workspace.id);
    try {
      const denied = await reset(new Request("http://localhost/reset", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: workspace.id }) });
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({ error: "Finish or retry pending refunds first" });
      expect(repository.getPlan(workspace.id, plan.id)?.status).toBe("executing");
    } finally { repository.releaseLock(workspace.id, owner); }
  });

  it.each([
    { note_to_payer: "key" }, { request_id: "key" }, { invoice_id: "other", note_to_payer: "key" },
    { invoice_id: "key", request_id: "other" }, { invoice_id: "key", amount: undefined },
    { invoice_id: "key", id: "" }, { invoice_id: "key", status: "" },
    { invoice_id: "key", amount: { currency_code: "EUR", value: "10.00" } },
    { invoice_id: "key", amount: { currency_code: "USD", value: "9.00" } },
    { invoice_id: "other", stored: true }, { amount: undefined, stored: true }, { id: "other-refund", stored: true },
  ])("rejects incomplete or contradictory refund evidence: %j", async ({ stored, ...overrides }) => {
    const { workspace } = prepared();
    const event = repository.appendLedger({ workspaceId: workspace.id, bookingId: "b", kind: "refund", amount: "10.00", paypalId: stored ? "refund" : "", captureId: "capture", requestId: "key", status: "REQUESTED" });
    const refund = { id: "refund", status: "COMPLETED", amount: { currency_code: "USD", value: "10.00" }, ...overrides };
    transport(async () => Response.json(stored ? refund : { id: "capture", status: "REFUNDED", refunds: [refund] }));
    expect(await lookupRefund(event)).toEqual({ kind: "unknown" });
  });
});
