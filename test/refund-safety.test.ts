import { setSdkTransport } from "./paypalTransport";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeRepository, Repository, withWorkspaceLock, type LedgerEvent } from "../lib/store";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { executeRefund } from "../lib/executor/refund";
import { executePlan } from "../lib/executor/executePlan";
import { reconcileRefund } from "../lib/executor/reconcileRefund";
import { REFUND_REPLAY_WINDOW_MS } from "../lib/executor/refund-policy";
import { checkRefund, REFUND_SWEEP_CAP, startRefundSweep, sweepRefunds } from "../lib/executor/refund-sweep";
import { POST as ownerCheck } from "../app/api/workspaces/[id]/refunds/check/route";
import { POST as ownerRetry } from "../app/api/workspaces/[id]/refunds/retry/route";
import { createCustomerLinks } from "../lib/choices/service";
import { applyPlan } from "../lib/solver/validate";
import { paymentsNeedingAttention } from "../lib/recovery/payment-attention";
import { processWebhook } from "../lib/paypal/webhook";

let repository: Repository, directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rebook-refund-safety-"));
  vi.stubEnv("DATA_DIR", directory);
  repository = new Repository(directory);
  vi.stubEnv("PAYPAL_CLIENT_ID", randomUUID());
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  vi.spyOn(console, "error").mockImplementation(() => {});
  // An unstubbed SDK operation must fail locally, never access the network.
  setSdkTransport(async () => { throw new Error("Unexpected transport call"); });
});
afterEach(() => {
  const timers = globalThis as typeof globalThis & { rebookRefundSweepTimer?: ReturnType<typeof setInterval> };
  clearInterval(timers.rebookRefundSweepTimer); delete timers.rebookRefundSweepTimer;
  closeRepository();
  repository.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function prepared() {
  const state = seedStudio();
  for (const booking of state.bookings) booking.payment!.simulated = false;
  const workspace = repository.createWorkspace(state);
  for (const booking of state.bookings) repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id,
    kind: "capture", amount: booking.amount, paypalId: booking.payment!.captureId, captureId: booking.payment!.captureId,
    requestId: `capture:${booking.id}`, status: "COMPLETED" });
  const plan = repository.createPlan(workspace.id, replan(state, demoDisruption));
  return { workspace, plan, actions: plan.bookingActions.filter((item) => item.action === "refund") };
}
function transport(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const send = vi.fn(async (url: string, init: RequestInit) => url.endsWith("/token")
    ? Response.json({ access_token: "token", token_type: "Bearer", expires_in: 3600 }) : handler(url, init));
  setSdkTransport(send);
  return send;
}
function reservation(workspaceId: string, booking: ReturnType<typeof seedStudio>["bookings"][number], age: number, status = "REQUESTED", amount = "4.00") {
  return repository.appendLedger({ workspaceId, bookingId: booking.id, kind: "refund", captureId: booking.payment!.captureId,
    amount, paypalId: "", requestId: `partial:${booking.id}`, partial: true, status,
    firstAttemptAt: new Date(Date.now() - age).toISOString() });
}
function refund(event: LedgerEvent, status = "COMPLETED") {
  return { id: `refund-${event.bookingId}`, status, invoice_id: event.requestId, amount: { currency_code: "USD", value: event.amount } };
}
function runRefund(event: LedgerEvent) {
  return withWorkspaceLock(repository, event.workspaceId, (owner) => executeRefund(event.workspaceId,
    { bookingId: event.bookingId, amount: event.amount, partial: event.partial, reason: "Price difference" }, event.requestId,
    repository, () => repository.renewLock(event.workspaceId, owner)));
}

it.each([REFUND_REPLAY_WINDOW_MS, 46 * 86_400_000])("reserves an unknown partial refund aged %i ms for review, without a second POST", async (age) => {
  const { workspace } = prepared();
  const event = reservation(workspace.id, workspace.state.bookings[0], age);
  const send = transport(async (_url, init) => { expect(init.method).toBe("GET"); throw new Error("PayPal unavailable"); });
  expect(await runRefund(event)).toMatchObject({ status: "NEEDS_REVIEW", error: expect.stringContaining("avoid a duplicate") });
  expect(await runRefund(event)).toMatchObject({ status: "NEEDS_REVIEW" });
  expect(send.mock.calls.some(([, init]) => init.method === "POST" && !String(init.body).includes("grant_type"))).toBe(false);
  expect(repository.ledgerSummary(workspace.id).pending).toBe("4.00");
  expect(paymentsNeedingAttention(workspace.state, repository.listLedger(workspace.id))).toEqual([
    expect.objectContaining({ status: "NEEDS_REVIEW", amount: "4.00", since: event.firstAttemptAt, ageMinutes: Math.floor(age / 60_000) }),
  ]);
  // Another operation cannot spend the money reserved for an uncertain partial refund.
  const result = await executeRefund(workspace.id, { bookingId: event.bookingId, amount: "1.00", partial: true, reason: "Other" }, "other", repository, () => {});
  expect(result).toMatchObject({ status: "FAILED", error: expect.stringContaining("reserved") });
});

it("replays a young unknown partial refund with the SAME request ID and amount, preserving its first-attempt clock across restart", async () => {
  const { workspace } = prepared();
  const event = reservation(workspace.id, workspace.state.bookings[0], 30 * 60_000);
  const send = transport(async (_url, init) => {
    if (init.method === "GET") throw new Error("Unavailable");
    expect((init.headers as Record<string, string>)["PayPal-Request-Id"]).toBe(event.requestId);
    expect(JSON.parse(init.body as string).amount.value).toBe("4.00");
    throw new Error("Unknown outcome");
  });
  expect((await runRefund(event)).status).toBe("REQUESTED");
  repository.close(); repository = new Repository(directory);
  expect((await runRefund(event)).status).toBe("REQUESTED");
  expect(send.mock.calls.filter(([url]) => url.endsWith("/refund"))).toHaveLength(2);
  expect(repository.latestMoneyEvents(workspace.id).find((item) => item.requestId === event.requestId)?.firstAttemptAt).toBe(event.firstAttemptAt);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(event.firstAttemptAt!) + REFUND_REPLAY_WINDOW_MS);
  expect((await runRefund(event)).status).toBe("NEEDS_REVIEW");
  expect(send.mock.calls.filter(([url]) => url.endsWith("/refund"))).toHaveLength(2);
});

it("settles an existing old partial refund from capture evidence without a POST or changing the booking's moved status", async () => {
  const { workspace } = prepared();
  const booking = workspace.state.bookings[0]; booking.status = "moved";
  repository.saveState(workspace.id, workspace.state);
  const event = reservation(workspace.id, booking, 50 * 86_400_000);
  const send = transport(async (_url, init) => {
    expect(init.method).toBe("GET");
    return Response.json({ id: event.captureId, status: "PARTIALLY_REFUNDED", refunds: [refund(event)] });
  });
  expect(await runRefund(event)).toMatchObject({ status: "COMPLETED" });
  expect(send.mock.calls.filter(([url]) => url.endsWith("/refund"))).toHaveLength(0);
  expect(repository.ledgerSummary(workspace.id)).toMatchObject({ refunded: "4.00", pending: "0.00" });
  expect(repository.requireWorkspace(workspace.id).state.bookings[0].status).toBe("moved");
});

it("allows an old retry only when PayPal proves an unrefunded completed capture", async () => {
  const { workspace } = prepared();
  const event = reservation(workspace.id, workspace.state.bookings[0], 50 * 86_400_000, "NEEDS_REVIEW");
  const send = transport(async (_url, init) => init.method === "GET"
    ? Response.json({ id: event.captureId, status: "COMPLETED" }) : Response.json(refund(event), { status: 201 }));
  expect((await runRefund(event)).status).toBe("COMPLETED");
  expect(send.mock.calls.filter(([url]) => url.endsWith("/refund"))).toHaveLength(1);
});

it("immediately restores review if an old retry permitted by proven absence loses its response", async () => {
  const { workspace } = prepared();
  const event = reservation(workspace.id, workspace.state.bookings[0], 50 * 86_400_000, "NEEDS_REVIEW");
  transport(async (_url, init) => {
    if (init.method === "GET") return Response.json({ id: event.captureId, status: "COMPLETED" });
    throw new Error("Unknown retry outcome");
  });
  expect(await runRefund(event)).toMatchObject({ status: "NEEDS_REVIEW", error: expect.stringContaining("avoid a duplicate") });
  expect(repository.ledgerSummary(workspace.id).pending).toBe("4.00");
});

it.each([false, true])("fences both success and failure after lease loss mid-call (failure=%s), then reconciles without overwriting a newer result", async (failure) => {
  const { workspace } = prepared();
  const booking = workspace.state.bookings[0];
  const owner = repository.acquireLock(workspace.id);
  let replacement = "", reads = 0;
  transport(async (_url, init) => {
    if (init.method === "GET") { reads++; throw new Error("Reconciliation unavailable"); }
    repository.releaseLock(workspace.id, owner);
    replacement = repository.acquireLock(workspace.id);
    const current = repository.latestMoneyEvents(workspace.id).find((item) => item.requestId === "lease-test")!;
    repository.appendLedger({ ...current, status: "PENDING", paypalId: "new-owner-refund" });
    if (failure) throw new Error("Lost response");
    return Response.json({ id: "stale-response", status: "COMPLETED" });
  });
  await expect(executeRefund(workspace.id, { bookingId: booking.id, amount: "4.00", partial: true, reason: "Difference" },
    "lease-test", repository, () => repository.renewLock(workspace.id, owner))).rejects.toThrow("lease expired");
  expect(reads).toBe(1);
  expect(repository.latestMoneyEvents(workspace.id).find((item) => item.requestId === "lease-test"))
    .toMatchObject({ status: "PENDING", paypalId: "new-owner-refund" });
  repository.releaseLock(workspace.id, replacement);
});

it.each(["REQUESTED", "NEEDS_REVIEW"])("discards stale reconciliation observations when a webhook settles a %s refund during its GET", async (status) => {
  const { workspace } = prepared();
  const event = reservation(workspace.id, workspace.state.bookings[0], 10 * 60_000, status);
  transport(async () => {
    processWebhook(JSON.stringify({ id: "settled-during-get", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: {
      ...refund(event), capture_id: event.captureId,
    } }), repository);
    return Response.json({ id: event.captureId, status: "PARTIALLY_REFUNDED", refunds: [refund(event, "PENDING")] });
  });
  await reconcileRefund(event, repository);
  expect(repository.latestMoneyEvents(workspace.id).find((item) => item.requestId === event.requestId)?.status).toBe("COMPLETED");
  expect(repository.ledgerSummary(workspace.id)).toMatchObject({ refunded: "4.00", pending: "0.00" });
});

it("recovers the first-attempt deadline from legacy ledger history rather than the most recent retry", async () => {
  const { workspace } = prepared();
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = Date.now(); vi.setSystemTime(now - 2 * REFUND_REPLAY_WINDOW_MS);
  const event = reservation(workspace.id, workspace.state.bookings[0], 0);
  vi.setSystemTime(now);
  repository.appendLedger({ ...event, error: "Recent retry with unknown outcome" });
  const db = new DatabaseSync(join(directory, "rebook.sqlite"));
  db.prepare("UPDATE ledger SET data = json_remove(data, '$.firstAttemptAt') WHERE json_extract(data, '$.kind') = 'refund'").run();
  db.close(); repository.close(); repository = new Repository(directory);
  expect(repository.dueRefunds(now, 5 * 60_000, 10)).toHaveLength(1);
  transport(async (_url, init) => { expect(init.method).toBe("GET"); throw new Error("Unavailable"); });
  expect((await runRefund(event)).status).toBe("NEEDS_REVIEW");
  expect(repository.latestMoneyEvents(workspace.id).find((item) => item.requestId === event.requestId)?.firstAttemptAt).toBe(event.firstAttemptAt);
});

it("caps sweep work, runs single-flight, backs off across repository restart, and never POSTs", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { workspace } = prepared();
  const events = workspace.state.bookings.slice(0, REFUND_SWEEP_CAP + 2).map((booking, index) =>
    reservation(workspace.id, booking, 2 * REFUND_REPLAY_WINDOW_MS, index % 2 ? "PENDING" : "REQUESTED"));
  expect(events).toHaveLength(REFUND_SWEEP_CAP + 2);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = transport(async (_url, init) => { expect(init.method).toBe("GET"); await gate; throw new Error("Unknown"); });
  const first = sweepRefunds(repository);
  expect(sweepRefunds(repository, workspace.id)).toBe(first);
  release();
  expect(await first).toBe(REFUND_SWEEP_CAP);
  expect(send.mock.calls.filter(([, init]) => init.method === "GET")).toHaveLength(REFUND_SWEEP_CAP);
  expect(repository.latestMoneyEvents(workspace.id).filter((item) => item.status === "NEEDS_REVIEW")).toHaveLength(REFUND_SWEEP_CAP / 2);
  expect(await sweepRefunds(repository)).toBe(2);
  expect(await sweepRefunds(repository)).toBe(0);
  repository.close(); repository = new Repository(directory);
  expect(await sweepRefunds(repository)).toBe(0);
  vi.setSystemTime(Date.now() + 60_000);
  expect(await sweepRefunds(repository)).toBe(REFUND_SWEEP_CAP);
  expect(await sweepRefunds(repository)).toBe(2);
  vi.setSystemTime(Date.now() + 60_000);
  expect(await sweepRefunds(repository)).toBe(0); // Second backoff is two minutes.
  expect(send.mock.calls.some(([url]) => url.endsWith("/refund"))).toBe(false);
});

it("does not sweep fresh attempts or an execution whose lease is still held; owner checks remain read-only", async () => {
  const { workspace } = prepared();
  const fresh = reservation(workspace.id, workspace.state.bookings[0], 60_000);
  const old = reservation(workspace.id, workspace.state.bookings[1], 2 * REFUND_REPLAY_WINDOW_MS);
  const send = transport(async () => { throw new Error("Unavailable"); });
  const owner = repository.acquireLock(workspace.id);
  expect(await sweepRefunds(repository)).toBe(0);
  expect(send).not.toHaveBeenCalled();
  repository.releaseLock(workspace.id, owner);
  expect(await checkRefund(workspace.id, old.requestId, repository)).toEqual({ kind: "unknown" });
  expect(repository.latestMoneyEvents(workspace.id).find((item) => item.requestId === fresh.requestId)?.status).toBe("REQUESTED");
  expect(repository.latestMoneyEvents(workspace.id).find((item) => item.requestId === old.requestId)?.status).toBe("NEEDS_REVIEW");
});

it("reconciles on server startup and every minute without a page load, creating only one timer", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const { workspace } = prepared();
  const event = reservation(workspace.id, workspace.state.bookings[0], 2 * REFUND_REPLAY_WINDOW_MS);
  const send = transport(async (_url, init) => { expect(init.method).toBe("GET"); throw new Error("Unavailable"); });
  startRefundSweep();
  const timers = globalThis as typeof globalThis & { rebookRefundSweepTimer?: ReturnType<typeof setInterval> };
  const firstTimer = timers.rebookRefundSweepTimer;
  startRefundSweep(); expect(timers.rebookRefundSweepTimer).toBe(firstTimer);
  expect(await sweepRefunds(repository)).toBe(1);
  expect(repository.latestMoneyEvents(workspace.id).find((item) => item.requestId === event.requestId)?.status).toBe("NEEDS_REVIEW");
  await vi.advanceTimersByTimeAsync(60_000);
  await sweepRefunds(repository);
  expect(send.mock.calls.filter(([, init]) => init.method === "GET")).toHaveLength(2);
});

it("scopes Check with PayPal to the owner's workspace and never POSTs money", async () => {
  const { workspace } = prepared();
  const other = prepared();
  const event = reservation(workspace.id, workspace.state.bookings[0], 2 * REFUND_REPLAY_WINDOW_MS);
  const send = transport(async (_url, init) => { expect(init.method).toBe("GET"); throw new Error("Unavailable"); });
  const request = () => new Request("http://localhost/refunds/check", { method: "POST", body: JSON.stringify({ requestId: event.requestId }) });
  const denied = await ownerCheck(request(), { params: Promise.resolve({ id: other.workspace.id }) });
  expect(denied.status).toBe(404); expect(send).not.toHaveBeenCalled();
  const checked = await ownerCheck(request(), { params: Promise.resolve({ id: workspace.id }) });
  expect(checked.status).toBe(200); expect(await checked.json()).toEqual({ kind: "unknown" });
  expect(repository.latestMoneyEvents(workspace.id).find((item) => item.requestId === event.requestId)?.status).toBe("NEEDS_REVIEW");
});

it("executes at most three refunds concurrently, persists live progress and keeps UI order after partial failure", async () => {
  const { workspace, plan, actions } = prepared();
  let active = 0, peak = 0;
  const pending: { key: string; resolve: (response: Response) => void }[] = [];
  transport(async (_url, init) => {
    active++; peak = Math.max(peak, active);
    const key = (init.headers as Record<string, string>)["PayPal-Request-Id"];
    const response = await new Promise<Response>((resolve) => { pending.push({ key, resolve }); });
    active--; return response;
  });
  const run = executePlan(workspace.id, plan.id, repository);
  await vi.waitFor(() => expect(pending).toHaveLength(3));
  expect(repository.getPlan(workspace.id, plan.id)?.refundProgress).toEqual({ done: 0, total: actions.length });
  // Finish the third refund first. The persisted view still uses booking action order.
  pending[2].resolve(Response.json({ id: "third", status: "COMPLETED" }));
  await vi.waitFor(() => expect(pending).toHaveLength(4));
  expect(repository.getPlan(workspace.id, plan.id)?.refundProgress).toEqual({ done: 1, total: actions.length });
  expect(repository.getPlan(workspace.id, plan.id)?.results[2].status).toBe("COMPLETED");
  pending[0].resolve(Response.json({ name: "UNPROCESSABLE_ENTITY", message: "Declined" }, { status: 422 }));
  pending[1].resolve(Response.json({ id: "second", status: "PENDING" }));
  for (let index = 3; index < actions.length; index++) {
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(index));
    pending[index].resolve(Response.json({ id: `refund-${index}`, status: "COMPLETED" }));
  }
  const result = await run;
  expect(peak).toBe(3);
  expect(result.plan.status).toBe("partially_failed");
  expect(result.results.map((item) => item.bookingId)).toEqual(actions.map((item) => item.bookingId));
  expect(result.results.map((item) => item.status)).toEqual(["FAILED", "PENDING", ...actions.slice(2).map(() => "COMPLETED")]);
  expect(result.plan.refundProgress).toEqual({ done: actions.length, total: actions.length });
});

it("joins in-flight refunds on lease loss mid-batch, stops queued work, and resumes after restart without duplicating accepted refunds", async () => {
  const { workspace, plan, actions } = prepared();
  const acquire = repository.acquireLock.bind(repository);
  let originalOwner = "", replacement = "", released = 0;
  vi.spyOn(repository, "acquireLock").mockImplementation((id) => { const owner = acquire(id); originalOwner ||= owner; return owner; });
  const pending: (() => void)[] = [];
  const accepted = new Map<string, ReturnType<typeof refund>>();
  const keys: string[] = [];
  transport(async (url, init) => {
    if (init.method === "GET") {
      const captureId = url.split("/").at(-1)!;
      return Response.json({ id: captureId, status: "REFUNDED", refunds: [accepted.get(captureId)] });
    }
    const key = (init.headers as Record<string, string>)["PayPal-Request-Id"];
    keys.push(key);
    const event = repository.latestMoneyEvents(workspace.id).find((item) => item.requestId === key)!;
    accepted.set(event.captureId, refund(event));
    await new Promise<void>((resolve) => { pending.push(resolve); });
    released++;
    return Response.json(refund(event));
  });
  let settled = false;
  const run = executePlan(workspace.id, plan.id, repository).then(() => { settled = true; }, () => { settled = true; });
  await vi.waitFor(() => expect(pending).toHaveLength(3));
  repository.releaseLock(workspace.id, originalOwner); replacement = acquire(workspace.id);
  pending[0]();
  await vi.waitFor(() => expect(released).toBe(1));
  expect(settled).toBe(false); // Other upstream calls still own their durable reservations.
  pending[1](); pending[2]();
  await run;
  expect(keys).toHaveLength(3);
  expect(repository.getPlan(workspace.id, plan.id)?.status).toBe("executing");
  expect(repository.getPlan(workspace.id, plan.id)?.refundProgress?.done).toBe(0);
  expect(repository.latestMoneyEvents(workspace.id).filter((item) => item.kind === "refund" && item.status === "COMPLETED")).toHaveLength(3);
  repository.releaseLock(workspace.id, replacement);
  repository.close(); repository = new Repository(directory);
  transport(async (_url, init) => {
    const key = (init.headers as Record<string, string>)["PayPal-Request-Id"];
    keys.push(key);
    return Response.json({ id: `new-${key}`, status: "COMPLETED" });
  });
  const result = await executePlan(workspace.id, plan.id, repository);
  expect(result.plan.status).toBe("executed");
  expect(keys).toHaveLength(actions.length);
  expect(new Set(keys).size).toBe(actions.length);
  expect(result.results.map((item) => item.bookingId)).toEqual(actions.map((item) => item.bookingId));
  expect(repository.ledgerSummary(workspace.id)).toMatchObject({ refunded: plan.totals.refundAmount, pending: "0.00" });
});

it.each([409, 422])("keeps an unresolved original reserved when its replay is rejected with %i", async (code) => {
  const { workspace } = prepared();
  const booking = workspace.state.bookings[0];
  const event = reservation(workspace.id, booking, 60_000);
  const send = transport(async (_url, init) => {
    if (init.method === "GET") throw new Error("PayPal unavailable");
    return Response.json({ name: code === 409 ? "PREVIOUS_REQUEST_IN_PROGRESS" : "UNPROCESSABLE_ENTITY", message: "Rejected" }, { status: code });
  });
  expect(await runRefund(event)).toMatchObject({ status: "REQUESTED" });
  expect(send.mock.calls.filter(([, init]) => init.method === "POST" && !String(init.body ?? "").includes("grant_type"))).not.toHaveLength(0);
  expect(repository.ledgerSummary(workspace.id).pending).toBe("4.00");
  // The capture stays reserved: a different refund cannot claim the same money.
  const other = await withWorkspaceLock(repository, workspace.id, (owner) => executeRefund(workspace.id,
    { bookingId: booking.id, amount: booking.amount, reason: "Cancelled" }, `other:${booking.id}`, repository, () => repository.renewLock(workspace.id, owner)));
  expect(other.status).toBe("FAILED");
});

it("does not overwrite a refund a webhook completed while the request failed", async () => {
  const { workspace } = prepared();
  const booking = workspace.state.bookings[0];
  transport(async (_url, init) => {
    if (init.method === "GET") throw new Error("PayPal unavailable");
    repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "refund", captureId: booking.payment!.captureId,
      amount: "4.00", paypalId: "WEBHOOK-REFUND", requestId: `partial:${booking.id}`, partial: true, status: "COMPLETED" });
    return Response.json({ name: "INTERNAL_SERVER_ERROR", message: "Lost" }, { status: 500 });
  });
  const result = await withWorkspaceLock(repository, workspace.id, (owner) => executeRefund(workspace.id,
    { bookingId: booking.id, amount: "4.00", partial: true, reason: "Price difference" }, `partial:${booking.id}`, repository, () => repository.renewLock(workspace.id, owner)));
  expect(result).toMatchObject({ status: "COMPLETED", paypalId: "WEBHOOK-REFUND" });
  expect(repository.latestMoneyEvents(workspace.id).find((event) => event.requestId === `partial:${booking.id}`)?.status).toBe("COMPLETED");
  expect(repository.ledgerSummary(workspace.id).refunded).toBe("4.00");
});

it("a writer that lost its lease reserves nothing and never POSTs", async () => {
  const { workspace } = prepared();
  const booking = workspace.state.bookings[0];
  const send = transport(async () => { throw new Error("must not be called"); });
  await expect(executeRefund(workspace.id, { bookingId: booking.id, amount: booking.amount, reason: "Cancelled" }, `lost:${booking.id}`, repository,
    () => { throw new Error("Workspace execution lease expired"); })).rejects.toThrow("lease expired");
  expect(send).not.toHaveBeenCalled();
  expect(repository.latestMoneyEvents(workspace.id).some((event) => event.kind === "refund")).toBe(false);
});

it("lets the owner retry a customer's reviewed refund only after PayPal proves it absent", async () => {
  const { workspace, plan } = prepared();
  const other = prepared();
  createCustomerLinks(plan, workspace.state, applyPlan(workspace.state, plan), repository);
  const link = repository.listCustomerLinks(workspace.id).find((item) => item.kind === "choice")!;
  const booking = workspace.state.bookings.find((item) => item.id === link.bookingId)!;
  const requestId = `choice:${link.id}`;
  repository.saveCustomerLink({ ...link, reply: { action: "refund", amount: booking.amount, requestId, at: new Date().toISOString() } });
  const event = repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "refund", captureId: booking.payment!.captureId,
    amount: booking.amount, paypalId: "", requestId, status: "NEEDS_REVIEW", firstAttemptAt: new Date(Date.now() - 2 * REFUND_REPLAY_WINDOW_MS).toISOString() });
  const request = () => new Request("http://localhost/refunds/retry", { method: "POST", body: JSON.stringify({ requestId }) });
  const posts = (send: ReturnType<typeof transport>) => send.mock.calls.filter(([url]) => url.endsWith("/refund"));

  let send = transport(async (_url, init) => { expect(init.method).toBe("GET"); throw new Error("Unavailable"); });
  expect((await ownerRetry(request(), { params: Promise.resolve({ id: other.workspace.id }) })).status).toBe(404);
  const unknown = await ownerRetry(request(), { params: Promise.resolve({ id: workspace.id }) });
  expect(await unknown.json()).toEqual({ status: "NEEDS_REVIEW" });
  expect(posts(send)).toHaveLength(0);

  send = transport(async (_url, init) => init.method === "GET"
    ? Response.json({ id: event.captureId, status: "COMPLETED" }) : Response.json(refund(event), { status: 201 }));
  const retried = await ownerRetry(request(), { params: Promise.resolve({ id: workspace.id }) });
  expect(await retried.json()).toEqual({ status: "COMPLETED" });
  expect(posts(send)).toHaveLength(1);
  expect(repository.requireWorkspace(workspace.id).state.bookings.find((item) => item.id === booking.id)?.status).toBe("refunded");
});
