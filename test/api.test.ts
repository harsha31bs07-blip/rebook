import { setSdkTransport } from "./paypalTransport";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as create } from "../app/api/workspaces/route";
import { GET as read } from "../app/api/workspaces/[id]/route";
import { POST as propose } from "../app/api/workspaces/[id]/plans/route";
import { POST as approve } from "../app/api/workspaces/[id]/plans/[planId]/approve/route";
import { POST as reset } from "../app/api/workspaces/[id]/reset/route";
import { POST as interpret } from "../app/api/workspaces/[id]/interpret/route";
import { GET as planDetails } from "../app/api/workspaces/[id]/plans/[planId]/route";
import { demoDisruption, demoDisruptionFor } from "../lib/seed/seed";
import { addLocalDays, localParts, zonedTimeToUtc } from "../lib/domain/time";
import { replan } from "../lib/solver/replan";
import { closeRepository, getRepository } from "../lib/store";
import { seedStudio } from "../lib/seed/seed";
import { startWarmPool, waitForWorkspacePreparation } from "../lib/demo/createWorkspace";
import { register } from "../instrumentation";
import { processWebhook } from "../lib/paypal/webhook";
import { limits } from "../lib/api/limits";

let directory: string;
beforeEach(() => {
  limits.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-05T15:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "rebook-api-"));
  vi.stubEnv("DATA_DIR", directory); vi.stubEnv("DEMO_REAL_CAPTURES", "0");
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(async () => {
  await waitForWorkspacePreparation();
  closeRepository(); rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});
function post(body: unknown = {}, ip = randomUUID()) {
  return new Request("http://localhost/api/workspaces", { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
describe("workspace API", () => {
  it("projects webhook settlement into GET plan and workspace results", async () => {
    const repository = getRepository();
    const workspace = repository.createWorkspace(seedStudio());
    const plan = repository.createPlan(workspace.id, replan(workspace.state, demoDisruption));
    repository.savePlan({ ...plan, status: "executed", basis: workspace.state });
    const refunds = plan.bookingActions.filter((action) => action.action === "refund");
    for (const action of refunds) {
      const booking = workspace.state.bookings.find((item) => item.id === action.bookingId)!;
      const captureId = booking.payment!.captureId;
      repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "capture", amount: booking.amount,
        paypalId: captureId, captureId, requestId: `capture:${booking.id}`, status: "COMPLETED" });
      repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "refund", amount: booking.amount,
        paypalId: `refund:${booking.id}`, captureId, requestId: `${plan.id}:${booking.id}`, status: "PENDING" });
    }
    const before = await (await planDetails(new Request("http://localhost"), { params: Promise.resolve({ id: workspace.id, planId: plan.id }) })).json();
    expect(before.plan.results[0].status).toBe("PENDING");
    const action = refunds[0];
    processWebhook(JSON.stringify({ id: "settled", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: {
      id: `refund:${action.bookingId}`, amount: { currency_code: "USD", value: action.amount },
    } }), repository);
    const after = await (await planDetails(new Request("http://localhost"), { params: Promise.resolve({ id: workspace.id, planId: plan.id }) })).json();
    expect(after.plan.results[0].status).toBe("COMPLETED");
    const view = await (await read(new Request("http://localhost"), context(workspace.id))).json();
    expect(view.plans[0].results[0].status).toBe("COMPLETED");
    expect(view.plans[0].results.slice(1).every((item: { status: string }) => item.status === "PENDING")).toBe(true);
  });
  it("returns explanations and customer drafts before and after cancelled sessions leave the schedule", async () => {
    const state = seedStudio();
    state.sessions = state.sessions.slice(0, 1);
    state.bookings = state.bookings.filter((booking) => booking.sessionId === state.sessions[0].id);
    state.bookings.forEach((booking) => { booking.payment!.simulated = true; });
    const { id } = getRepository().createWorkspace(state);
    for (const booking of state.bookings) getRepository().appendLedger({ workspaceId: id, bookingId: booking.id,
      kind: "capture", amount: booking.amount, paypalId: booking.payment!.captureId, captureId: booking.payment!.captureId,
      requestId: `capture-${booking.id}`, status: "SIMULATED" });
    const plan = await (await propose(post({ disruption: { kind: "closure", from: "2026-11-09T05:00:00Z", to: "2026-11-16T05:00:00Z" } }), context(id))).json();
    expect(plan.sessionChanges.some((change: { remedy: string }) => change.remedy === "cancel")).toBe(true);
    const params = { params: Promise.resolve({ id, planId: plan.id }) };
    const beforeResponse = await planDetails(new Request("http://localhost"), params);
    expect(beforeResponse.status).toBe(200);
    const before = await beforeResponse.json();
    expect(before.explanation.bullets.join(" ")).toContain(plan.totals.refundAmount);
    expect(before.messages).toHaveLength(plan.bookingActions.length);
    expect(before.plan).not.toHaveProperty("basis");
    expect((await approve(post(), params)).status).toBe(200);
    const after = await (await planDetails(new Request("http://localhost"), params)).json();
    expect(after.plan.status).toBe("executed");
    expect(after.plan).not.toHaveProperty("basis");
    expect(after.messages).toEqual(before.messages);
    expect(after.sessions).toEqual(before.sessions);
    expect((await planDetails(new Request("http://localhost"), { params: Promise.resolve({ id, planId: randomUUID() }) })).status).toBe(404);
  });
  it("returns the persisted week and uses it with the real clock for interpretation and planning", async () => {
    const now = "2026-12-03T15:00:00.000Z";
    vi.setSystemTime(new Date(now));
    vi.stubEnv("GEMINI_API_KEY", "");
    const { id } = await (await create(post())).json();
    await waitForWorkspacePreparation();
    const workspace = await (await read(new Request("http://localhost"), context(id))).json();
    const { weekStart, timezone } = workspace.state.studio;
    expect(weekStart).toBe("2026-12-07T05:00:00.000Z");
    const monday = await (await interpret(post({ text: "Maya has the flu Monday" }), context(id))).json();
    const disruption = demoDisruptionFor(weekStart, timezone);
    expect(monday.disruption).toMatchObject({ from: disruption.from, to: disruption.to });
    const today = await (await interpret(post({ text: "Maya has the flu today" }), context(id))).json();
    expect(today).toMatchObject({ kind: "clarify", question: expect.stringContaining("studio week") });
    expect(today).not.toHaveProperty("disruption");
    const timer = vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(2900);
    const response = await propose(post({ disruption }), context(id));
    timer.mockRestore();
    expect(response.status).toBe(200);
    const plan = await response.json();
    expect(plan.planningDurationMs).toBe(2800);
    const persisted = await (await planDetails(new Request("http://localhost"), { params: Promise.resolve({ id, planId: plan.id }) })).json();
    expect(persisted.plan.planningDurationMs).toBe(2800);
    const horizonEnd = zonedTimeToUtc(addLocalDays(localParts(weekStart, timezone).dateKey, 7), "00:00", timezone);
    const expected = replan(workspace.state, disruption, { now, horizonEnd });
    expect(plan).toMatchObject(expected);
    expect(plan.now).toBe(now);
    expect(plan.totals.sessionsAffected).toBe(3);
    expect(new Set(plan.bookingActions.map((action: { action: string }) => action.action))).toEqual(new Set(["keep", "move", "refund"]));
  });
  it.each(["2026-10-26T04:00:00Z", "2026-11-09T05:00:00Z"])("never moves outside the viewed week starting %s", async (week) => {
    vi.setSystemTime(new Date("2026-10-23T15:00:00Z"));
    const state = seedStudio(42, week);
    const { id } = getRepository().createWorkspace(state);
    const startKey = localParts(week, state.studio.timezone).dateKey;
    const horizonEnd = zonedTimeToUtc(addLocalDays(startKey, 7), "00:00", state.studio.timezone);
    const response = await propose(post({ disruption: demoDisruptionFor(week, state.studio.timezone) }), context(id));
    expect(response.status).toBe(200);
    const plan = await response.json();
    expect(plan.sessionChanges.filter((change: { remedy: string }) => change.remedy === "move_time")).toHaveLength(2);
    for (const change of plan.sessionChanges) {
      expect(Date.parse(change.after.start)).toBeGreaterThanOrEqual(Date.parse(week));
      expect(Date.parse(change.after.end)).toBeLessThanOrEqual(Date.parse(horizonEnd));
      if (change.remedy === "move_time") {
        expect(localParts(change.after.start, state.studio.timezone).dateKey).toBe(addLocalDays(startKey, 1));
      }
    }
    // No fallback into next week when the entire visible week is disrupted (including DST Sunday).
    const closed = await (await propose(post({ disruption: { kind: "closure", from: week, to: horizonEnd } }), context(id))).json();
    expect(closed.sessionChanges.every((change: { remedy: string }) => change.remedy === "cancel")).toBe(true);
  });
  it("returns status and progress and rejects plans and approval until ready", async () => {
    const repository = getRepository();
    const workspace = repository.createWorkspace(seedStudio(), undefined, { preparing: true });
    const response = await read(new Request("http://localhost"), context(workspace.id));
    expect(await response.json()).toMatchObject({ status: "preparing", progress: { done: 0, total: workspace.state.bookings.length } });
    expect((await propose(post({ disruption: demoDisruption }), context(workspace.id))).status).toBe(409);
    expect((await approve(post(), { params: Promise.resolve({ id: workspace.id, planId: randomUUID() }) })).status).toBe(409);
    repository.savePreparation(workspace.id, "failed", workspace.progress);
    expect((await propose(post({ disruption: demoDisruption }), context(workspace.id))).status).toBe(409);
    expect((await approve(post(), { params: Promise.resolve({ id: workspace.id, planId: randomUUID() }) })).status).toBe(409);
    repository.savePreparation(workspace.id, "ready", { done: workspace.progress.total, total: workspace.progress.total });
    expect((await propose(post({ disruption: demoDisruption }), context(workspace.id))).status).toBe(200);
  });
  it("never exposes a private pool workspace through GET or planning", async () => {
    const pooled = getRepository().createWorkspace(seedStudio(), undefined, { pooled: true });
    expect((await read(new Request("http://localhost"), context(pooled.id))).status).toBe(404);
    expect((await propose(post({ disruption: demoDisruption }), context(pooled.id))).status).toBe(404);
  });
  it("fills at server startup and returns a ready pool claim through POST, then refills", async () => {
    vi.stubEnv("DEMO_WARM_POOL", "1");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await register();
    await startWarmPool();
    const pooled = getRepository().readyPoolWorkspace()!;
    expect((await read(new Request("http://localhost"), context(pooled.id))).status).toBe(404);
    const response = await create(post());
    expect(response.status).toBe(202);
    const { id } = await response.json();
    expect(id).not.toBe(pooled.id);
    expect(await (await read(new Request("http://localhost"), context(id))).json()).toMatchObject({ status: "ready" });
    await waitForWorkspacePreparation();
    expect(getRepository().readyPoolWorkspace()?.id).not.toBe(pooled.id);
    expect(getRepository().readyPoolWorkspace()?.id).toBeDefined();
  });
  it("accepts creation while captures are still blocked and later reports ready", async () => {
    vi.stubEnv("DEMO_REAL_CAPTURES", "1");
    vi.stubEnv("PAYPAL_ENV", "sandbox");
    vi.stubEnv("PAYPAL_CLIENT_ID", randomUUID());
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "mock-secret");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    setSdkTransport(async (url, init) => {
      if (url.endsWith("/token")) return Response.json({ access_token: "token", token_type: "Bearer", expires_in: 3600 });
      await blocked;
      const key = (init.headers as Record<string, string>)["PayPal-Request-Id"];
      return Response.json({ id: `order-${key}`, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: `capture-${key}`, status: "COMPLETED" }] } }] });
    });
    try {
      const response = await create(post());
      expect(response.status).toBe(202);
      const { id } = await response.json();
      const preparing = await (await read(new Request("http://localhost"), context(id))).json();
      expect(preparing.status).toBe("preparing");
      expect(preparing.progress.done).toBeLessThan(preparing.progress.total);
      expect((await propose(post({ disruption: demoDisruption }), context(id))).status).toBe(409);
      expect((await approve(post(), { params: Promise.resolve({ id, planId: randomUUID() }) })).status).toBe(409);
      release();
      await waitForWorkspacePreparation();
      expect(await (await read(new Request("http://localhost"), context(id))).json()).toMatchObject({ status: "ready",
        progress: { done: preparing.progress.total, total: preparing.progress.total } });
    } finally { release(); }
  });
  it("creates, reads, plans, approves idempotently and resets an isolated workspace", async () => {
    const response = await create(post());
    expect(response.status).toBe(202);
    const { id } = await response.json();
    const readResponse = await read(new Request("http://localhost"), context(id));
    expect(readResponse.status).toBe(200);
    expect((await readResponse.json()).state.bookings.length).toBeGreaterThan(0);
    await waitForWorkspacePreparation();
    const proposal = await propose(post({ disruption: demoDisruption }), context(id));
    expect(proposal.status).toBe(200);
    const plan = await proposal.json();
    expect(plan.status).toBe("proposed");
    const approvalContext = { params: Promise.resolve({ id, planId: plan.id }) };
    const execution = await approve(post(), approvalContext);
    expect(execution.status).toBe(200);
    expect((await execution.json()).plan.status).toBe("executed");
    expect((await approve(post(), approvalContext)).status).toBe(200);
    const resetResponse = await reset(post(), context(id));
    expect(await resetResponse.json()).toEqual({ id });
    const afterReset = await (await read(new Request("http://localhost"), context(id))).json();
    expect(afterReset.plans).toEqual([]);
    expect(afterReset.state.bookings.every((booking: { status: string }) => booking.status === "confirmed")).toBe(true);
  });
  it("validates inputs and returns sanitized errors", async () => {
    expect((await create(post({ unexpected: true }))).status).toBe(400);
    expect((await create(new Request("http://localhost", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await read(new Request("http://localhost"), context("bad"))).status).toBe(404);
    const missing = await read(new Request("http://localhost"), context("missing123"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "expired" });
    const { id } = await (await create(post())).json();
    await waitForWorkspacePreparation();
    expect((await propose(post({ disruption: { kind: "closure" } }), context(id))).status).toBe(400);
    expect((await approve(post(), { params: Promise.resolve({ id, planId: randomUUID() }) })).status).toBe(404);
  });
  it("limits creation and reset calls together to five per IP per hour", async () => {
    const ip = randomUUID();
    const { id } = await (await create(post({}, ip))).json();
    await waitForWorkspacePreparation();
    for (let index = 0; index < 4; index += 1) expect((await reset(post({}, ip), context(id))).status).toBe(200);
    expect((await create(post({}, ip))).status).toBe(429);
    expect((await reset(post({}, ip), context(id))).status).toBe(429);
    expect((await create(post())).status).toBe(202);
  });
});
