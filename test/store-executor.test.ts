import { setSdkTransport } from "./paypalTransport";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { executePlan } from "../lib/executor/executePlan";
import { Repository } from "../lib/store";
import { activeConstraints } from "../lib/solver/constraints";
import { applyPlan, validate } from "../lib/solver/validate";

let directory: string;
let repository: Repository;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rebook-executor-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("PAYPAL_CLIENT_ID", randomUUID());
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "mock-secret");
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  repository = new Repository();
});
afterEach(() => {
  repository.close();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

function prepared(simulated = false) {
  const state = seedStudio();
  for (const booking of state.bookings) booking.payment = { ...booking.payment!, simulated };
  const workspace = repository.createWorkspace(state);
  for (const booking of state.bookings) repository.appendLedger({
    workspaceId: workspace.id, bookingId: booking.id, kind: "capture", amount: booking.amount,
    paypalId: booking.payment!.captureId, captureId: booking.payment!.captureId,
    requestId: `${workspace.id}${booking.id}`, status: simulated ? "SIMULATED" : "COMPLETED",
  });
  const plan = repository.createPlan(workspace.id, replan(state, demoDisruption));
  return { workspace, plan };
}

function mockedRefunds(status: (index: number) => string = () => "COMPLETED") {
  let count = 0;
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/token")) return Response.json({ access_token: "token", token_type: "Bearer", expires_in: 3600 });
    if (init?.method === "GET") return Response.json({ id: String(url).split("/").at(-1), status: "COMPLETED" });
    count += 1;
    const next = status(count);
    return Response.json(next === "FAILED" ? { name: "UNPROCESSABLE_ENTITY", message: "Declined" } : { id: `refund-${count}`, status: next }, { status: next === "FAILED" ? 422 : 201 });
  });
  vi.stubGlobal("fetch", fetch); setSdkTransport(fetch);
  return fetch;
}

describe("SQLite repository", () => {
  it("round-trips isolated state, plans, append-only ledger and raw webhook events", () => {
    const { workspace, plan } = prepared(true);
    const other = repository.createWorkspace(seedStudio());
    const event = repository.listLedger(workspace.id)[0];
    repository.appendLedger(event);
    repository.appendLedger({ ...event, status: "REVERSED" });
    const count = repository.listLedger(workspace.id).length;
    expect(count).toBe(workspace.state.bookings.length + 1);
    repository.recordWebhook("event", '{"id":"event"}');
    repository.close();
    repository = new Repository(directory);
    expect(repository.requireWorkspace(workspace.id)).toEqual(workspace);
    expect(repository.getPlan(workspace.id, plan.id)).toEqual(plan);
    expect(repository.getPlan(other.id, plan.id)).toBeUndefined();
    expect(repository.listLedger(other.id)).toEqual([]);
    expect(repository.listLedger(workspace.id)).toHaveLength(count);
    expect(repository.getWebhook("event")).toBe('{"id":"event"}');
    expect(repository.recordWebhook("event", "changed")).toBe(false);
    expect(repository.ledgerSummary(workspace.id).captured).toBe("0.00");
  });
  it("rejects a second writer while a workspace lease is active", () => {
    const workspace = repository.createWorkspace(seedStudio());
    const owner = repository.acquireLock(workspace.id);
    expect(() => repository.acquireLock(workspace.id)).toThrow("Workspace is busy");
    repository.releaseLock(workspace.id, owner);
    const next = repository.acquireLock(workspace.id);
    repository.releaseLock(workspace.id, next);
  });
});

describe("plan execution", () => {
  it("restores active constraints for previously persisted applied plans", () => {
    const { workspace, plan } = prepared(true);
    repository.saveState(workspace.id, applyPlan(workspace.state, plan));
    repository.savePlan({ ...plan, status: "executed", basis: workspace.state });
    expect(activeConstraints(repository.requireWorkspace(workspace.id).state)).toEqual([plan.disruption]);
  });
  it("persists approved constraints so a later disruption cannot reuse Maya's absence", async () => {
    const { workspace, plan } = prepared(true);
    await executePlan(workspace.id, plan.id, repository);
    repository.close(); repository = new Repository(directory);
    const state = repository.requireWorkspace(workspace.id).state;
    expect(activeConstraints(state)).toEqual([plan.disruption]);
    const cover = plan.sessionChanges.find((change) => change.after?.instructorId !== change.before.instructorId && change.after)!;
    const nextDisruption = { kind: "instructor_unavailable" as const, instructorId: cover.after!.instructorId,
      from: cover.after!.start, to: cover.after!.end };
    const next = replan(state, nextDisruption);
    expect(validate(state, next).ok).toBe(true);
    for (const change of next.sessionChanges) if (change.after) {
      expect(change.after.instructorId === cover.before.instructorId && change.after.start === cover.before.start).toBe(false);
    }
  });
  it("refunds exactly the refund actions and makes zero new calls on re-run", async () => {
    const { workspace, plan } = prepared();
    const fetch = mockedRefunds();
    const refunds = plan.bookingActions.filter((action) => action.action === "refund");
    expect(refunds.length).toBeGreaterThan(0);
    const result = await executePlan(workspace.id, plan.id, repository);
    expect(result.plan.status).toBe("executed");
    expect(result.results.map((item) => item.bookingId)).toEqual(refunds.map((item) => item.bookingId));
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/refund"))).toHaveLength(refunds.length);
    expect(repository.requireWorkspace(workspace.id).state.bookings.filter((booking) => booking.status === "refunded")).toHaveLength(refunds.length);
    fetch.mockClear();
    const again = await executePlan(workspace.id, plan.id, repository);
    expect(again.results).toEqual(result.results);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps PENDING refunds pending and continues after a failed refund", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { workspace, plan } = prepared();
    const fetch = mockedRefunds((index) => index === 1 ? "PENDING" : index === 2 ? "FAILED" : "COMPLETED");
    const result = await executePlan(workspace.id, plan.id, repository);
    expect(result.plan.status).toBe("partially_failed");
    expect(result.results[0].status).toBe("PENDING");
    expect(result.results[1].status).toBe("FAILED");
    expect(result.results.slice(2).every((item) => item.status === "COMPLETED")).toBe(true);
    expect(repository.requireWorkspace(workspace.id).state.bookings.find((booking) => booking.id === result.results[0].bookingId)?.status).toBe("refund_pending");
    fetch.mockClear();
    await executePlan(workspace.id, plan.id, repository);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/refund"))).toHaveLength(1);
  });
  it("never calls PayPal for simulated payments", async () => {
    const { workspace, plan } = prepared(true);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch); setSdkTransport(fetch);
    const result = await executePlan(workspace.id, plan.id, repository);
    expect(result.plan.status).toBe("executed");
    expect(result.results.every((item) => item.status === "SIMULATED")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(repository.ledgerSummary(workspace.id).simulatedRefunded).toBe(plan.totals.refundAmount);
  });
  it("rejects a stale or invalid proposed plan before any refund", async () => {
    const { workspace, plan } = prepared();
    plan.bookingActions[0].amount = "9999.00";
    repository.savePlan(plan);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch); setSdkTransport(fetch);
    await expect(executePlan(workspace.id, plan.id, repository)).rejects.toThrow("no longer valid");
    expect(fetch).not.toHaveBeenCalled();
    expect(repository.getPlan(workspace.id, plan.id)?.status).toBe("proposed");
  });
  it("resumes a crash with the original request id and skips already completed refunds", async () => {
    const { workspace, plan } = prepared();
    const { applyPlan } = await import("../lib/solver/validate");
    repository.saveState(workspace.id, applyPlan(workspace.state, plan));
    repository.savePlan({ ...plan, status: "executing", basis: workspace.state });
    const actions = plan.bookingActions.filter((action) => action.action === "refund");
    for (const [index, action] of actions.slice(0, 2).entries()) {
      const captureId = workspace.state.bookings.find((item) => item.id === action.bookingId)!.payment!.captureId;
      repository.appendLedger({ workspaceId: workspace.id, bookingId: action.bookingId, kind: "refund", amount: action.amount,
        requestId: `${plan.id}:${action.bookingId}`, captureId, paypalId: index === 0 ? "prior-refund" : "", status: index === 0 ? "COMPLETED" : "REQUESTED" });
    }
    const fetch = mockedRefunds();
    const result = await executePlan(workspace.id, plan.id, repository);
    expect(result.plan.status).toBe("executed");
    const calls = fetch.mock.calls.filter(([url]) => String(url).endsWith("/refund"));
    expect(calls).toHaveLength(actions.length - 1);
    const init = (calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>)["PayPal-Request-Id"]).toBe(`${plan.id}:${actions[1].bookingId}`);
  });
  it("does not refund a capture reserved by another operation or beyond the captured amount", async () => {
    const { workspace, plan } = prepared();
    const actions = plan.bookingActions.filter((action) => action.action === "refund");
    for (const [index, action] of actions.slice(0, 2).entries()) {
      const booking = workspace.state.bookings.find((item) => item.id === action.bookingId)!;
      if (index === 0) repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "refund", amount: booking.amount,
        paypalId: "prior-refund", captureId: booking.payment!.captureId, requestId: "other-plan", status: "PENDING" });
      else repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "capture", amount: "1.00",
        paypalId: booking.payment!.captureId, captureId: booking.payment!.captureId, requestId: `${workspace.id}${booking.id}`, status: "COMPLETED", debugId: "different-amount" });
    }
    // Amounts on a capture never change in PayPal; use a fresh fixture booking's smaller recorded capture.
    const state = repository.requireWorkspace(workspace.id).state;
    const booking = state.bookings.find((item) => item.id === actions[1].bookingId)!;
    booking.payment!.captureId = "smaller-capture";
    repository.saveState(workspace.id, state);
    repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "capture", amount: "1.00", paypalId: "smaller-capture", captureId: "smaller-capture", requestId: "smaller", status: "COMPLETED" });
    const fetch = mockedRefunds();
    const result = await executePlan(workspace.id, plan.id, repository);
    expect(result.results[0].status).toBe("FAILED");
    expect(result.results[1].status).toBe("FAILED");
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/refund"))).toHaveLength(actions.length - 2);
  });
});
