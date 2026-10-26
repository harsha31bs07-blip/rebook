import { randomBytes } from "node:crypto";
import type { State } from "../domain/types";
import { createCardCapture, lookupCardCapture, PayPalError } from "../paypal/client";
import { demoDisruptionFor, floodDisruptionFor, nextWeekStart, seedStudio } from "../seed/seed";
import { affectedSessions } from "../solver/validate";
import { getRepository, StoreError, withWorkspaceLock, type Repository, type Workspace } from "../store";
import { reconcileRefund } from "../executor/reconcileRefund";
import { limits } from "../api/limits";

export type SeedProgress = { completed: number; total: number; bookingId: string; status: "COMPLETED" | "SIMULATED" | "FAILED" };
export type CreateWorkspaceOptions = { repository?: Repository; onProgress?: (progress: SeedProgress) => void };
export class WorkspaceCreationError extends StoreError {
  constructor(public workspaceId: string) { super(502, "Some sandbox captures failed; the workspace and successful captures were preserved"); }
}

/** Capture only the bookings that either demo scenario can affect, using the seed's own clock. */
export function realCaptureBookingIds(state: State): Set<string> {
  const now = state.sessions.map((session) => session.start).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  if (!now) return new Set();
  const { weekStart, timezone } = state.studio;
  const sessions = new Set([demoDisruptionFor(weekStart, timezone), floodDisruptionFor(weekStart, timezone)]
    .flatMap((disruption) => affectedSessions(state, disruption, now)).map((session) => session.id));
  return new Set(state.bookings.filter((booking) => sessions.has(booking.sessionId)).map((booking) => booking.id));
}

async function seedPayments(workspaceId: string, options: CreateWorkspaceOptions, repository: Repository, owner: string): Promise<Workspace> {
  const initial = repository.requireWorkspace(workspaceId, true).state;
  const persisted = repository.latestMoneyEvents(workspaceId).filter((event) => event.kind === "capture");
  const scenarioIds = process.env.DEMO_REAL_CAPTURES === "0" ? new Set<string>() : realCaptureBookingIds(initial);
  // A restart must preserve the original capture mode and idempotency key, even if env changed.
  const realIds = new Set(initial.bookings.filter((booking) => {
    const event = persisted.find((item) => item.bookingId === booking.id);
    return event ? event.status !== "SIMULATED" : scenarioIds.has(booking.id);
  }).map((booking) => booking.id));
  const capturedIds = new Set(initial.bookings.filter((booking) => {
    const event = persisted.find((item) => item.bookingId === booking.id && item.status === "COMPLETED");
    return event?.captureId && booking.payment?.captureId === event.captureId;
  }).map((booking) => booking.id));
  let completed = 0;
  let failed = false;
  let nextIndex = 0;
  const report = (bookingId: string, status: SeedProgress["status"]) => {
    completed += 1;
    repository.updatePreparation(workspaceId, "preparing", { done: completed, total: initial.bookings.length });
    // An observer must never turn a completed payment into a failed operation.
    try { options.onProgress?.({ completed, total: initial.bookings.length, bookingId, status }); }
    catch { console.error("Workspace progress callback failed"); }
  };
  // Batch the initial ledger writes; no network work occurs inside the SQLite transaction.
  repository.transaction(() => {
    for (const booking of initial.bookings) {
      if (persisted.some((item) => item.bookingId === booking.id)) continue;
      const real = realIds.has(booking.id);
      repository.appendLedger({ workspaceId, bookingId: booking.id, kind: "capture", amount: booking.amount,
        paypalId: real ? "" : booking.payment!.captureId, captureId: real ? "" : booking.payment!.captureId,
        requestId: `${workspaceId}${booking.id}`, status: real ? "REQUESTED" : "SIMULATED" });
    }
  });
  repository.transaction(() => {
    for (const booking of initial.bookings) {
      if (!realIds.has(booking.id)) report(booking.id, "SIMULATED");
      else if (capturedIds.has(booking.id)) report(booking.id, "COMPLETED");
    }
  });
  const realBookings = initial.bookings.filter((booking) => realIds.has(booking.id) && !capturedIds.has(booking.id));
  const worker = async () => {
    while (nextIndex < realBookings.length) {
      const booking = realBookings[nextIndex++];
      repository.renewLock(workspaceId, owner);
      const requestId = persisted.find((item) => item.bookingId === booking.id)?.requestId ?? `${workspaceId}${booking.id}`;
      const input = { workspaceId, bookingId: booking.id, kind: "capture" as const, amount: booking.amount, requestId };
      try {
        const previous = repository.latestMoneyEvents(workspaceId).find((event) => event.kind === "capture" && event.requestId === requestId)!;
        const firstAttemptAt = previous.firstAttemptAt ?? repository.listLedger(workspaceId)
          .find((event) => event.kind === "capture" && event.requestId === requestId)!.createdAt;
        const age = Date.now() - Date.parse(firstAttemptAt);
        const expired = previous.status === "UNKNOWN" || !Number.isFinite(age) || age >= 6 * 3_600_000;
        const payment = expired
          ? await lookupCardCapture(booking.amount, { workspaceId, bookingId: booking.id, requestId }, firstAttemptAt)
          : await createCardCapture(booking.amount, { workspaceId, bookingId: booking.id, requestId });
        if (!payment) {
          repository.transaction(() => {
            const current = repository.requireWorkspace(workspaceId, true).state;
            current.bookings.find((item) => item.id === booking.id)!.payment = {
              orderId: `UNKNOWN-ORDER-${requestId}`, captureId: `UNKNOWN-CAP-${requestId}`, simulated: true, unknown: true,
            };
            repository.saveState(workspaceId, current);
            repository.appendLedger({ ...input, paypalId: "", captureId: "", status: "UNKNOWN", error: "payment unknown (simulated fallback)" });
          });
          report(booking.id, "SIMULATED");
          continue;
        }
        repository.transaction(() => {
          const current = repository.requireWorkspace(workspaceId, true).state;
          current.bookings.find((item) => item.id === booking.id)!.payment = { orderId: payment.orderId, captureId: payment.captureId, simulated: false };
          repository.saveState(workspaceId, current);
          repository.appendLedger({ ...input, paypalId: payment.captureId, captureId: payment.captureId, status: payment.status, debugId: payment.debugId });
        });
        report(booking.id, "COMPLETED");
      } catch (error) {
        failed = true;
        repository.appendLedger({ ...input, paypalId: "", captureId: "", status: error instanceof PayPalError && error.status < 500 ? "FAILED" : "REQUESTED", debugId: error instanceof PayPalError ? error.debugId : undefined });
        report(booking.id, "FAILED");
      }
    }
  };
  const workers = await Promise.allSettled(Array.from({ length: Math.min(8, realBookings.length) }, worker));
  if (workers.some((result) => result.status === "rejected")) failed = true;
  const workspace = repository.savePreparation(workspaceId, failed ? "failed" : "ready", { done: completed, total: initial.bookings.length },
    failed ? "Some sandbox captures failed or have an unknown outcome. Successful payments were preserved; open a fresh demo to continue." : undefined);
  if (failed) throw new WorkspaceCreationError(workspaceId);
  return workspace;
}

function initialState(reset = false): State {
  const state = seedStudio(42, nextWeekStart(new Date().toISOString(), "America/New_York"));
  const realIds = process.env.DEMO_REAL_CAPTURES === "0" ? new Set<string>() : realCaptureBookingIds(state);
  // Reset keeps its workspace and audit history. New booking identities give every capture a fresh key.
  const generation = reset ? `${randomBytes(6).toString("hex")}-` : "";
  for (const booking of state.bookings) {
    booking.payment = { ...booking.payment!, simulated: !realIds.has(booking.id) };
    booking.id = `${generation}${booking.id}`;
    if (reset) booking.payment = { ...booking.payment, orderId: `SEED-ORDER-${booking.id}`, captureId: `SEED-CAP-${booking.id}` };
  }
  return state;
}

export async function createWorkspace(options: CreateWorkspaceOptions = {}): Promise<Workspace> {
  const repository = options.repository ?? getRepository();
  const state = initialState();
  const release = limits.preparation(state.bookings.filter((booking) => !booking.payment?.simulated).length);
  try {
    const workspace = repository.createWorkspace(state, undefined, { preparing: true });
    return await prepare(workspace.id, options, repository);
  } finally { release(); }
}

async function prepare(id: string, options: CreateWorkspaceOptions, repository: Repository): Promise<Workspace> {
  try { return await withWorkspaceLock(repository, id, (owner) => seedPayments(id, options, repository, owner)); }
  catch (error) {
    const workspace = repository.requireWorkspace(id, true);
    if (error instanceof StoreError && [409, 429, 503].includes(error.status)) throw error;
    repository.savePreparation(id, "failed", workspace.progress, workspace.preparationError ?? (error instanceof Error ? error.message : "Workspace preparation failed"));
    throw error;
  }
}

// Keep background promises alive for this server process. No payment work runs in a DB transaction.
const processSeeding = globalThis as typeof globalThis & { rebookSeeding?: {
  background: Set<Promise<unknown>>; poolFills: WeakMap<Repository, Promise<void>>;
} };
const { background, poolFills } = processSeeding.rebookSeeding ??= {
  background: new Set<Promise<unknown>>(), poolFills: new WeakMap<Repository, Promise<void>>(),
};
function track<T>(promise: Promise<T>): Promise<T> {
  background.add(promise);
  void promise.finally(() => background.delete(promise)).catch(() => {});
  return promise;
}
function backgroundPreparation(id: string, options: CreateWorkspaceOptions, repository: Repository): Promise<Workspace> {
  // Yield to the HTTP response before even the simulated ledger/progress writes begin.
  return track(new Promise<void>((resolve) => setImmediate(resolve)).then(() => prepare(id, options, repository)));
}

export function startWarmPool(repository: Repository = getRepository()): Promise<void> {
  if (process.env.DEMO_WARM_POOL !== "1" || repository.readyPoolWorkspace()) return Promise.resolve();
  const pending = poolFills.get(repository);
  if (pending) return pending;
  if (repository.stalePreparations(Date.now(), 0).some((workspace) => workspace.pooled)) return Promise.resolve();
  const state = initialState();
  let release: () => void;
  try { release = limits.preparation(state.bookings.filter((booking) => !booking.payment?.simulated).length, true, true); }
  catch (error) { if (error instanceof StoreError && error.status === 429) return Promise.resolve(); throw error; }
  let workspace: Workspace;
  try { workspace = repository.createWorkspace(state, undefined, { preparing: true, pooled: true }); }
  catch (error) { release(); throw error; }
  const filling = track(backgroundPreparation(workspace.id, {}, repository).then(() => {}, () => {
    console.error("Warm workspace preparation failed");
  }).finally(() => { release(); poolFills.delete(repository); }));
  poolFills.set(repository, filling);
  return filling;
}

/** Return before captures finish; GET exposes durable status and progress. */
export function beginWorkspace(options: CreateWorkspaceOptions = {}): Workspace {
  const repository = options.repository ?? getRepository();
  if (process.env.DEMO_WARM_POOL === "1") {
    const claimed = repository.claimPoolWorkspace();
    void startWarmPool(repository);
    if (claimed) return claimed;
  }
  const state = initialState();
  const release = limits.preparation(state.bookings.filter((booking) => !booking.payment?.simulated).length);
  let workspace: Workspace;
  try { workspace = repository.createWorkspace(state, undefined, { preparing: true }); }
  catch (error) { release(); throw error; }
  void backgroundPreparation(workspace.id, options, repository).catch(() => {
    console.error("Workspace preparation failed", { workspaceId: workspace.id });
  }).finally(release);
  return workspace;
}

export async function waitForWorkspacePreparation(): Promise<void> {
  await Promise.allSettled([...background]);
}

/** Recover preparations abandoned by a previous process, including unclaimed pool workspaces. */
export async function resumeStalePreparations(repository: Repository = getRepository(), deferRecent = false): Promise<void> {
  for (const workspace of repository.stalePreparations(Date.now(), deferRecent ? 0 : 120_000)) {
    let attempt = 0;
    const schedule = (delay: number) => {
      void track(new Promise<void>((resolve) => { const timer = setTimeout(resolve, delay); timer.unref(); }).then(recover));
    };
    const recover = async () => {
      try {
        const current = repository.getWorkspace(workspace.id, true);
        if (current?.status === "preparing") {
          const recentDelay = Date.parse(current.updatedAt) + 120_001 - Date.now();
          if (recentDelay > 0) { schedule(recentDelay); return; }
          const captured = new Set(repository.latestMoneyEvents(workspace.id).filter((event) => event.kind === "capture" && event.status === "COMPLETED").map((event) => event.bookingId));
          const release = limits.preparation(current.state.bookings.filter((booking) => !booking.payment?.simulated && !captured.has(booking.id)).length, false, !!current.pooled);
          try { await prepare(workspace.id, {}, repository); } finally { release(); }
        }
      } catch (error) {
        console.error("Workspace preparation recovery failed", { workspaceId: workspace.id });
        if (error instanceof StoreError && [409, 429, 503].includes(error.status)) {
          schedule([10_000, 30_000, 60_000][attempt++] ?? 120_000);
        }
      }
    };
    const delay = Date.parse(workspace.updatedAt) + 120_001 - Date.now();
    if (deferRecent && delay > 0) {
      // A quick restart must not strand preparations that have not yet aged past two minutes.
      schedule(delay);
    } else await recover();
  }
}

export async function resetWorkspace(workspaceId: string, options: CreateWorkspaceOptions = {}): Promise<Workspace> {
  const repository = options.repository ?? getRepository();
  repository.requireReadyWorkspace(workspaceId);
  const state = initialState(true);
  return withWorkspaceLock(repository, workspaceId, async (owner) => {
    for (const event of repository.latestMoneyEvents(workspaceId)) {
      if (event.kind !== "refund" || !["REQUESTED", "PENDING"].includes(event.status)) continue;
      repository.renewLock(workspaceId, owner);
      await reconcileRefund(event, repository);
    }
    if (repository.listCheckout(workspaceId).some((row) => row.status === "capturing") ||
      repository.latestMoneyEvents(workspaceId).some((event) => ["REQUESTED", "PENDING", "UNKNOWN"].includes(event.status)) ||
      repository.listPlans(workspaceId).some((plan) => ["executing", "partially_failed"].includes(plan.status))) {
      throw new StoreError(409, "Finish or retry pending refunds first");
    }
    const release = limits.preparation(state.bookings.filter((booking) => !booking.payment?.simulated).length);
    try {
      repository.renewLock(workspaceId, owner);
      repository.transaction(() => {
        repository.saveState(workspaceId, state); repository.clearPlans(workspaceId);
        repository.savePreparation(workspaceId, "preparing", { done: 0, total: state.bookings.length });
      });
      return await seedPayments(workspaceId, options, repository, owner);
    } finally { release(); }
  }).catch((error) => {
    // An active execution can hold the lease before reset can inspect its ledger.
    if (error instanceof StoreError && error.status === 409) throw new StoreError(409, "Finish or retry pending refunds first");
    throw error;
  });
}
