import { randomBytes } from "node:crypto";
import { addLocalDays, localParts } from "../domain/time";
import type { State } from "../domain/types";
import { createCardCapture, PayPalError } from "../paypal/client";
import { seedStudio } from "../seed/seed";
import { getRepository, StoreError, withWorkspaceLock, type Repository, type Workspace } from "../store";

export type SeedProgress = { completed: number; total: number; bookingId: string; status: "COMPLETED" | "SIMULATED" | "FAILED" };
export type CreateWorkspaceOptions = { repository?: Repository; onProgress?: (progress: SeedProgress) => void };
export class WorkspaceCreationError extends StoreError {
  constructor(public workspaceId: string) { super(502, "Some sandbox captures failed; the workspace and successful captures were preserved"); }
}

/** The explicit capture window is Monday and Tuesday; the current seed's Wednesday flood is simulated. */
export function realCaptureBookingIds(state: State): Set<string> {
  const days = state.sessions.map((session) => localParts(session.start, state.studio.timezone).dateKey).sort();
  if (!days.length) return new Set();
  const cutoff = addLocalDays(days[0], 2);
  const sessions = new Set(state.sessions.filter((session) => localParts(session.start, state.studio.timezone).dateKey < cutoff).map((session) => session.id));
  return new Set(state.bookings.filter((booking) => sessions.has(booking.sessionId)).map((booking) => booking.id));
}

async function seedPayments(workspaceId: string, options: CreateWorkspaceOptions, repository: Repository, owner: string): Promise<Workspace> {
  const initial = repository.requireWorkspace(workspaceId).state;
  const realIds = process.env.DEMO_REAL_CAPTURES === "0" ? new Set<string>() : realCaptureBookingIds(initial);
  let completed = 0;
  let failed = false;
  let nextIndex = 0;
  const report = (bookingId: string, status: SeedProgress["status"]) => {
    completed += 1;
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
  for (const booking of initial.bookings) if (!realIds.has(booking.id)) report(booking.id, "SIMULATED");
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
          const current = repository.requireWorkspace(workspaceId).state;
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
  const workers = await Promise.allSettled(Array.from({ length: Math.min(4, realBookings.length) }, worker));
  if (workers.some((result) => result.status === "rejected")) failed = true;
  if (failed) throw new WorkspaceCreationError(workspaceId);
  return repository.requireWorkspace(workspaceId);
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
  const workspace = repository.createWorkspace(initialState());
  return withWorkspaceLock(repository, workspace.id, (owner) => seedPayments(workspace.id, options, repository, owner));
}

export async function resetWorkspace(workspaceId: string, options: CreateWorkspaceOptions = {}): Promise<Workspace> {
  const repository = options.repository ?? getRepository();
  return withWorkspaceLock(repository, workspaceId, async (owner) => {
    if (repository.listPlans(workspaceId).some((plan) => plan.status === "executing")) throw new StoreError(409, "An interrupted execution must finish before reset");
    if (repository.latestMoneyEvents(workspaceId).some((event) => event.status === "REQUESTED")) throw new StoreError(409, "An unresolved payment must be reconciled before reset");
    repository.transaction(() => { repository.saveState(workspaceId, initialState(true)); repository.clearPlans(workspaceId); });
    return seedPayments(workspaceId, options, repository, owner);
  });
}
