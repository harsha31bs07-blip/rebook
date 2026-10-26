import { setSdkTransport } from "./paypalTransport";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginWorkspace, createWorkspace, realCaptureBookingIds, resetWorkspace, resumeStalePreparations, startWarmPool, waitForWorkspacePreparation, WorkspaceCreationError } from "../lib/demo/createWorkspace";
import { Repository, StoreError } from "../lib/store";
import { demoDisruptionFor, floodDisruptionFor, seedStudio } from "../lib/seed/seed";
import { localParts } from "../lib/domain/time";
import { affectedSessions } from "../lib/solver/validate";
import { limits } from "../lib/api/limits";

let directory: string;
let repository: Repository;
beforeEach(() => {
  limits.reset();
  directory = mkdtempSync(join(tmpdir(), "rebook-workspace-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  vi.stubEnv("PAYPAL_CLIENT_ID", randomUUID());
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "mock-secret");
  repository = new Repository();
});
afterEach(async () => {
  await waitForWorkspacePreparation();
  repository.close(); rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});
function mockedCaptures(failFirst = false) {
  let active = 0;
  let maxActive = 0;
  let count = 0;
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/token")) return Response.json({ access_token: "token", token_type: "Bearer", expires_in: 3600 });
    const number = ++count;
    active += 1; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    if (failFirst && number === 1) return Response.json({ name: "UNPROCESSABLE_ENTITY", message: "Declined" }, { status: 422 });
    const key = (init!.headers as Record<string, string>)["PayPal-Request-Id"];
    return Response.json({ id: `order-${key}`, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: `capture-${key}`, status: "COMPLETED" }] } }] }, { status: 201, headers: { "paypal-debug-id": `debug-${number}` } });
  });
  vi.stubGlobal("fetch", fetch); setSdkTransport(fetch);
  return { fetch, maxActive: () => maxActive };
}
describe("workspace seeding", () => {
  it.each(["admission", "lock", "unavailable"])("retries startup %s failures at 10s, 30s, 60s and every two minutes", async (failure) => {
    vi.stubEnv("DEMO_REAL_CAPTURES", "0");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    const state = seedStudio();
    for (const booking of state.bookings) booking.payment!.simulated = true;
    const workspace = repository.createWorkspace(state, undefined, { preparing: true });
    vi.setSystemTime(Date.now() + 120_001);
    let attempts = 0;
    if (failure === "admission") {
      const original = limits.preparation.bind(limits);
      vi.spyOn(limits, "preparation").mockImplementation((...args) => {
        if (++attempts <= 5) throw new StoreError(429, "busy");
        return original(...args);
      });
    } else {
      const original = repository.acquireLock.bind(repository);
      vi.spyOn(repository, "acquireLock").mockImplementation((...args) => {
        if (++attempts <= 5) throw new StoreError(failure === "unavailable" ? 503 : 409, "locked");
        return original(...args);
      });
    }
    await resumeStalePreparations(repository);
    for (const delay of [10_000, 30_000, 60_000, 120_000, 120_000]) {
      const before = attempts;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(attempts).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(before + 1);
    }
    await waitForWorkspacePreparation();
    expect(repository.requireWorkspace(workspace.id).status).toBe("ready");
  });

  it.each([false, true])("never replays an expired capture key; read-only lookup found=%s", async (found) => {
    vi.stubEnv("DEMO_REAL_CAPTURES", "1");
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = seedStudio();
    const booking = state.bookings[0];
    for (const item of state.bookings) item.payment!.simulated = item.id !== booking.id;
    const workspace = repository.createWorkspace(state, undefined, { preparing: true });
    const event = repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "capture", amount: booking.amount, paypalId: "", captureId: "", requestId: "original-key", status: "REQUESTED" });
    for (const item of state.bookings.slice(1)) repository.appendLedger({ workspaceId: workspace.id, bookingId: item.id, kind: "capture", amount: item.amount, paypalId: item.payment!.captureId, captureId: item.payment!.captureId, requestId: `${workspace.id}${item.id}`, status: "SIMULATED" });
    vi.setSystemTime(Date.now() + 3_600_000);
    repository.appendLedger({ ...event, status: "PENDING" });
    expect(repository.latestMoneyEvents(workspace.id)[0].firstAttemptAt).toBe(event.createdAt);
    vi.setSystemTime(Date.parse(event.createdAt) + 6 * 3_600_000);
    repository.close(); repository = new Repository(directory);
    const send = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/token")) return Response.json({ access_token: "token", token_type: "Bearer", expires_in: 3600 });
      expect(init.method).toBe("GET");
      if (url.includes("/reporting/transactions")) return Response.json({ transaction_details: found ? [{ transaction_info: {
        transaction_id: "existing-capture", transaction_status: "S", custom_field: `${workspace.id}:${booking.id}`,
        transaction_amount: { currency_code: "USD", value: booking.amount }, paypal_reference_id: "existing-order", paypal_reference_id_type: "ODR",
      } }] : [] });
      return Response.json({ id: "existing-order", status: "COMPLETED", purchase_units: [{ reference_id: booking.id, custom_id: `${workspace.id}:${booking.id}`, payments: { captures: [{ id: "existing-capture", status: "COMPLETED", amount: { currency_code: "USD", value: booking.amount } }] } }] });
    });
    setSdkTransport(send);
    await resumeStalePreparations(repository);
    const ready = repository.requireWorkspace(workspace.id);
    expect(ready.status).toBe("ready");
    expect(ready.state.bookings[0].payment).toMatchObject(found ? { captureId: "existing-capture", simulated: false } : { simulated: true, unknown: true });
    expect(repository.latestMoneyEvents(workspace.id).find((event) => event.requestId === "original-key")).toMatchObject({ status: found ? "COMPLETED" : "UNKNOWN", firstAttemptAt: event.createdAt });
    expect(send.mock.calls.some(([url, init]) => url.endsWith("/orders") && init.method === "POST")).toBe(false);
  });
  it("keeps retrying recovery when progress recently renewed the workspace timestamp", async () => {
    vi.stubEnv("DEMO_REAL_CAPTURES", "0");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    const workspace = repository.createWorkspace(seedStudio(), undefined, { preparing: true });
    vi.setSystemTime(Date.now() + 120_001);
    const acquire = repository.acquireLock.bind(repository);
    const lock = vi.spyOn(repository, "acquireLock").mockImplementationOnce(() => {
      repository.updatePreparation(workspace.id, "preparing", workspace.progress);
      throw new StoreError(409, "locked");
    }).mockImplementation(acquire);
    await resumeStalePreparations(repository);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(110_001);
    await waitForWorkspacePreparation();
    expect(lock).toHaveBeenCalledTimes(2);
    expect(repository.requireWorkspace(workspace.id).status).toBe("ready");
  });

  it("uses the earliest legacy ledger entry for the capture replay deadline", async () => {
    vi.stubEnv("DEMO_REAL_CAPTURES", "0");
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = seedStudio();
    const booking = state.bookings[0];
    const workspace = repository.createWorkspace(state, undefined, { preparing: true });
    const event = repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "capture", amount: booking.amount, paypalId: "", captureId: "", requestId: "legacy-key", status: "REQUESTED" });
    vi.setSystemTime(Date.now() + 5 * 3_600_000);
    repository.appendLedger({ ...event, status: "PENDING" });
    const db = new DatabaseSync(join(directory, "rebook.sqlite"));
    db.exec("UPDATE ledger SET data = json_remove(data, '$.firstAttemptAt')");
    db.close();
    vi.setSystemTime(Date.parse(event.createdAt) + 6 * 3_600_000);
    const send = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/token")) return Response.json({ access_token: "token", token_type: "Bearer", expires_in: 3600 });
      expect(init.method).toBe("GET");
      return Response.json({ transaction_details: [] });
    });
    setSdkTransport(send);
    await resumeStalePreparations(repository);
    expect(repository.latestMoneyEvents(workspace.id).find((item) => item.requestId === event.requestId))
      .toMatchObject({ status: "UNKNOWN", firstAttemptAt: event.createdAt });
    expect(repository.requireWorkspace(workspace.id).state.bookings[0].payment).toMatchObject({ unknown: true, simulated: true });
    expect(send.mock.calls.some(([, init]) => init.method === "GET")).toBe(true);
  });
  it("defers a recent interrupted preparation until the two-minute recovery threshold", async () => {
    vi.stubEnv("DEMO_REAL_CAPTURES", "0");
    vi.useFakeTimers();
    const workspace = repository.createWorkspace(seedStudio(), undefined, { preparing: true });
    await resumeStalePreparations(repository, true);
    expect(repository.requireWorkspace(workspace.id).status).toBe("preparing");
    await vi.advanceTimersByTimeAsync(120_001);
    await waitForWorkspacePreparation();
    expect(repository.requireWorkspace(workspace.id).status).toBe("ready");
  });
  it("resumes a stale preparation after restart with persisted keys and skips completed captures", async () => {
    vi.stubEnv("DEMO_REAL_CAPTURES", "1");
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = seedStudio();
    const ids = realCaptureBookingIds(state);
    for (const booking of state.bookings) booking.payment!.simulated = !ids.has(booking.id);
    const first = state.bookings.find((booking) => ids.has(booking.id))!;
    first.payment = { orderId: "existing-order", captureId: "existing-capture", simulated: false };
    const workspace = repository.createWorkspace(state, undefined, { preparing: true });
    const real = state.bookings.filter((booking) => ids.has(booking.id));
    for (const [index, booking] of real.entries()) repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id,
      kind: "capture", amount: booking.amount, requestId: `persisted-${booking.id}`,
      captureId: index === 0 ? "existing-capture" : "", paypalId: index === 0 ? "existing-capture" : "", status: index === 0 ? "COMPLETED" : "REQUESTED" });
    vi.setSystemTime(Date.now() + 120_001);
    repository.close(); repository = new Repository(directory);
    const { fetch } = mockedCaptures();
    await resumeStalePreparations(repository);
    const ready = repository.requireWorkspace(workspace.id);
    expect(ready.status).toBe("ready");
    expect(ready.state.bookings.find((booking) => booking.id === first.id)?.payment?.captureId).toBe("existing-capture");
    const calls = fetch.mock.calls.filter(([url]) => String(url).endsWith("/orders"));
    expect(calls).toHaveLength(real.length - 1);
    for (const call of calls) expect(((call[1] as RequestInit).headers as Record<string, string>)["PayPal-Request-Id"]).toMatch(/^persisted-/);
  });
  it("seeds and persists the following Monday when created on a Thursday", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-03T15:00:00Z"));
    vi.stubEnv("DEMO_REAL_CAPTURES", "0");
    const workspace = await createWorkspace({ repository });
    expect(workspace.state.studio.weekStart).toBe("2026-12-07T05:00:00.000Z");
    expect(repository.requireWorkspace(workspace.id).state.studio.weekStart).toBe(workspace.state.studio.weekStart);
    expect(localParts(workspace.state.sessions[0].start, workspace.state.studio.timezone).dateKey).toBe("2026-12-07");
  });
  it("can seed entirely simulated payments without credentials or network", async () => {
    vi.stubEnv("DEMO_REAL_CAPTURES", "0");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); setSdkTransport(fetch);
    const progress = vi.fn();
    const workspace = await createWorkspace({ repository, onProgress: progress });
    expect(workspace.id).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(workspace.state.bookings.length).toBe(seedStudio().bookings.length);
    expect(workspace.state.bookings.every((booking) => booking.payment?.simulated && booking.payment.captureId.startsWith("SEED-"))).toBe(true);
    expect(repository.listLedger(workspace.id)).toHaveLength(workspace.state.bookings.length);
    expect(repository.listLedger(workspace.id).every((event) => event.status === "SIMULATED")).toBe(true);
    expect(progress).toHaveBeenCalledTimes(workspace.state.bookings.length);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("captures only scenario-affected bookings with concurrency eight", async () => {
    vi.stubEnv("DEMO_REAL_CAPTURES", "1");
    const { fetch, maxActive } = mockedCaptures();
    const workspace = await createWorkspace({ repository });
    const state = workspace.state;
    const { weekStart, timezone } = state.studio;
    const demoDisruption = demoDisruptionFor(weekStart, timezone);
    const floodDisruption = floodDisruptionFor(weekStart, timezone);
    const now = state.sessions.map((session) => session.start).sort()[0];
    const realSessions = [demoDisruption, floodDisruption].flatMap((disruption) => affectedSessions(state, disruption, now));
    const realIds = new Set(realSessions.map((session) => session.id));
    const realBookings = workspace.state.bookings.filter((booking) => realIds.has(booking.sessionId));
    expect(realBookings.length).toBe(38);
    expect(realCaptureBookingIds(state)).toEqual(new Set(realBookings.map((booking) => booking.id)));
    expect(affectedSessions(state, floodDisruption, now).every((session) => realIds.has(session.id))).toBe(true);
    expect(realBookings.every((booking) => booking.payment?.simulated === false && booking.payment.captureId.startsWith("capture-"))).toBe(true);
    expect(workspace.state.bookings.filter((booking) => !realIds.has(booking.sessionId)).every((booking) => booking.payment?.simulated)).toBe(true);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/orders"))).toHaveLength(realBookings.length);
    expect(maxActive()).toBe(8);
    for (const booking of realBookings) {
      expect(repository.latestMoneyEvents(workspace.id).find((event) => event.bookingId === booking.id)).toMatchObject({
        kind: "capture", status: "COMPLETED", amount: booking.amount, paypalId: booking.payment!.captureId, requestId: `${workspace.id}${booking.id}`,
      });
    }
  });
  it("preserves successful captures and reports the workspace ID when a capture fails", async () => {
    vi.stubEnv("DEMO_REAL_CAPTURES", "1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockedCaptures(true);
    let failure: WorkspaceCreationError | undefined;
    try { await createWorkspace({ repository }); }
    catch (error) { expect(error).toBeInstanceOf(WorkspaceCreationError); failure = error as WorkspaceCreationError; }
    expect(failure).toBeDefined();
    expect(repository.requireWorkspace(failure!.workspaceId).status).toBe("failed");
    const ledger = repository.latestMoneyEvents(failure!.workspaceId);
    expect(ledger.filter((event) => event.status === "FAILED")).toHaveLength(1);
    expect(ledger.filter((event) => event.status === "COMPLETED").length).toBeGreaterThan(0);
  });
  it("returns preparing immediately and persists progress until ready", async () => {
    vi.stubEnv("DEMO_REAL_CAPTURES", "1");
    mockedCaptures();
    let started!: () => void;
    const firstProgress = new Promise<void>((resolve) => { started = resolve; });
    const workspace = beginWorkspace({ repository, onProgress: () => started() });
    expect(workspace.status).toBe("preparing");
    expect(workspace.progress.done).toBe(0);
    expect(repository.requireWorkspace(workspace.id).progress.done).toBe(0);
    await firstProgress;
    const preparing = repository.requireWorkspace(workspace.id);
    expect(preparing.status).toBe("preparing");
    expect(preparing.progress.done).toBeGreaterThan(0);
    expect(preparing.progress.done).toBeLessThan(preparing.progress.total);
    await waitForWorkspacePreparation();
    const ready = repository.requireWorkspace(workspace.id);
    expect(ready.status).toBe("ready");
    expect(ready.progress).toEqual({ done: ready.state.bookings.length, total: ready.state.bookings.length });
  });
  it("keeps pool workspaces private, claims instantly with a fresh ID and timestamp, and refills once", async () => {
    vi.stubEnv("DEMO_WARM_POOL", "1");
    vi.stubEnv("DEMO_REAL_CAPTURES", "1");
    const { fetch } = mockedCaptures();
    const firstFill = startWarmPool(repository);
    expect(startWarmPool(repository)).toBe(firstFill);
    await firstFill;
    const pooled = repository.readyPoolWorkspace()!;
    const pooledLedger = repository.listLedger(pooled.id);
    expect(pooled.status).toBe("ready");
    expect(repository.getWorkspace(pooled.id)).toBeUndefined();
    expect(() => repository.requireWorkspace(pooled.id)).toThrow("demo has ended");
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/orders"))).toHaveLength(38);
    const later = new Date(Date.parse(pooled.createdAt) + 1000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(later);
    const claimed = beginWorkspace({ repository });
    expect(claimed.status).toBe("ready");
    expect(claimed.id).not.toBe(pooled.id);
    expect(claimed.createdAt).toBe(later.toISOString());
    expect(claimed.pooled).toBeUndefined();
    expect(claimed.state).toEqual(pooled.state);
    expect(repository.getWorkspace(pooled.id, true)).toBeUndefined();
    expect(repository.listLedger(claimed.id)).toHaveLength(pooledLedger.length);
    expect(repository.latestMoneyEvents(claimed.id).map((event) => [event.bookingId, event.paypalId, event.requestId, event.status]).sort())
      .toEqual(pooledLedger.filter((event) => event.status !== "REQUESTED").map((event) => [event.bookingId, event.paypalId, event.requestId, event.status]).sort());
    await waitForWorkspacePreparation();
    const refill = repository.readyPoolWorkspace()!;
    expect(refill.id).not.toBe(pooled.id);
    expect(refill.id).not.toBe(claimed.id);
    expect(repository.getWorkspace(refill.id)).toBeUndefined();
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/orders"))).toHaveLength(76);
    vi.useRealTimers();
  });
  it("resets with fresh capture keys and booking IDs while retaining the money ledger", async () => {
    vi.stubEnv("DEMO_REAL_CAPTURES", "1");
    mockedCaptures();
    const first = await createWorkspace({ repository });
    const firstIds = new Set(first.state.bookings.map((booking) => booking.id));
    const captures = repository.latestMoneyEvents(first.id).filter((event) => event.status === "COMPLETED");
    const reset = await resetWorkspace(first.id, { repository });
    expect(reset.id).toBe(first.id);
    expect(reset.state.bookings.every((booking) => !firstIds.has(booking.id))).toBe(true);
    const nextCaptures = repository.latestMoneyEvents(first.id).filter((event) => event.status === "COMPLETED");
    expect(nextCaptures).toHaveLength(captures.length * 2);
    expect(new Set(nextCaptures.map((event) => event.paypalId)).size).toBe(captures.length * 2);
  });
  it("discards a stale pool week at claim and prepares a fresh workspace and pool", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-03T15:00:00Z"));
    vi.stubEnv("DEMO_WARM_POOL", "1");
    vi.stubEnv("DEMO_REAL_CAPTURES", "0");
    await startWarmPool(repository);
    const stale = repository.readyPoolWorkspace()!;
    expect(stale.state.studio.weekStart).toBe("2026-12-07T05:00:00.000Z");
    vi.setSystemTime(new Date("2026-12-07T05:00:00Z"));
    const fresh = beginWorkspace({ repository });
    expect(fresh.status).toBe("preparing");
    expect(fresh.state.studio.weekStart).toBe("2026-12-14T05:00:00.000Z");
    expect(repository.getWorkspace(stale.id, true)).toBeUndefined();
    expect(repository.listLedger(stale.id)).toEqual([]);
    await waitForWorkspacePreparation();
    expect(repository.requireReadyWorkspace(fresh.id).state.studio.weekStart).toBe(fresh.state.studio.weekStart);
    expect(repository.readyPoolWorkspace()?.state.studio.weekStart).toBe(fresh.state.studio.weekStart);
  });
});
