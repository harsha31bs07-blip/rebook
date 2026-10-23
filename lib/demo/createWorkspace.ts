import { randomBytes } from "node:crypto";
import type { State } from "../domain/types";
import { createCardCapture, PayPalError } from "../paypal/client";
import { demoDisruption, floodDisruption, seedStudio } from "../seed/seed";
import { affectedSessions } from "../solver/validate";
import { getRepository, StoreError, withWorkspaceLock, type Repository, type Workspace } from "../store";

export type SeedProgress = { completed: number; total: number; bookingId: string; status: "COMPLETED" | "SIMULATED" | "FAILED" };
export type CreateWorkspaceOptions = { repository?: Repository; onProgress?: (progress: SeedProgress) => void };
export class WorkspaceCreationError extends StoreError {
  constructor(public workspaceId: string) { super(502, "Some sandbox captures failed; the workspace and successful captures were preserved"); }
}

/** Capture only the bookings that either demo scenario can affect, using the seed's own clock. */
export function realCaptureBookingIds(state: State): Set<string> {
  const now = state.sessions.map((session) => session.start).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  if (!now) return new Set();
  const sessions = new Set([demoDisruption, floodDisruption].flatMap((disruption) => affectedSessions(state, disruption, now)).map((session) => session.id));
  return new Set(state.bookings.filter((booking) => sessions.has(booking.sessionId)).map((booking) => booking.id));
}

async function seedPayments(workspaceId: string, options: CreateWorkspaceOptions, repository: Repository, owner: string): Promise<Workspace> {
  const initial = repository.requireWorkspace(workspaceId, true).state;
  const realIds = process.env.DEMO_REAL_CAPTURES === "0" ? new Set<string>() : realCaptureBookingIds(initial);
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
      const real = realIds.has(booking.id);
      repository.appendLedger({ workspaceId, bookingId: booking.id, kind: "capture", amount: booking.amount,
        paypalId: real ? "" : booking.payment!.captureId, captureId: real ? "" : booking.payment!.captureId,
        requestId: `${workspaceId}${booking.id}`, status: real ? "REQUESTED" : "SIMULATED" });
    }
  });
  repository.transaction(() => {
    for (const booking of initial.bookings) if (!realIds.has(booking.id)) report(booking.id, "SIMULATED");
  });
  const realBookings = initial.bookings.filter((booking) => realIds.has(booking.id));
  const worker = async () => {
    while (nextIndex < realBookings.length) {
      const booking = realBookings[nextIndex++];
      repository.renewLock(workspaceId, owner);
      const requestId = `${workspaceId}${booking.id}`;
      const input = { workspaceId, bookingId: booking.id, kind: "capture" as const, amount: booking.amount, requestId };
      try {
        const payment = await createCardCapture(booking.amount, { workspaceId, bookingId: booking.id, requestId });
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
  const workspace = repository.savePreparation(workspaceId, failed ? "failed" : "ready", { done: completed, total: initial.bookings.length });
  if (failed) throw new WorkspaceCreationError(workspaceId);
  return workspace;
}

function initialState(reset = false): State {
  const state = seedStudio();
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
  const workspace = repository.createWorkspace(initialState(), undefined, { preparing: true });
  return prepare(workspace.id, options, repository);
}

async function prepare(id: string, options: CreateWorkspaceOptions, repository: Repository): Promise<Workspace> {
  try { return await withWorkspaceLock(repository, id, (owner) => seedPayments(id, options, repository, owner)); }
  catch (error) {
    const workspace = repository.requireWorkspace(id, true);
    repository.savePreparation(id, "failed", workspace.progress);
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
  const workspace = repository.createWorkspace(initialState(), undefined, { preparing: true, pooled: true });
  const filling = track(backgroundPreparation(workspace.id, {}, repository).then(() => {}, () => {
    console.error("Warm workspace preparation failed");
  }).finally(() => poolFills.delete(repository)));
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
  const workspace = repository.createWorkspace(initialState(), undefined, { preparing: true });
  void backgroundPreparation(workspace.id, options, repository).catch(() => {
    console.error("Workspace preparation failed", { workspaceId: workspace.id });
  });
  return workspace;
}

export async function waitForWorkspacePreparation(): Promise<void> {
  await Promise.allSettled([...background]);
}

export async function resetWorkspace(workspaceId: string, options: CreateWorkspaceOptions = {}): Promise<Workspace> {
  const repository = options.repository ?? getRepository();
  repository.requireReadyWorkspace(workspaceId);
  return withWorkspaceLock(repository, workspaceId, async (owner) => {
    if (repository.listPlans(workspaceId).some((plan) => plan.status === "executing")) throw new StoreError(409, "An interrupted execution must finish before reset");
    if (repository.latestMoneyEvents(workspaceId).some((event) => event.status === "REQUESTED")) throw new StoreError(409, "An unresolved payment must be reconciled before reset");
    repository.transaction(() => {
      const state = initialState(true);
      repository.saveState(workspaceId, state); repository.clearPlans(workspaceId);
      repository.savePreparation(workspaceId, "preparing", { done: 0, total: state.bookings.length });
    });
    return seedPayments(workspaceId, options, repository, owner);
  });
}
