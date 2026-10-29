import { getRepository, StoreError, withWorkspaceLock, type Repository } from "../store";
import { reconcileRefund } from "./reconcileRefund";
import { reviewUncertainRefund } from "./refund-policy";

export const REFUND_SWEEP_AGE_MS = 5 * 60_000;
export const REFUND_SWEEP_CAP = 10;
const processSweep = globalThis as typeof globalThis & {
  rebookRefundSweep?: Promise<number>;
  rebookRefundSweepTimer?: ReturnType<typeof setInterval>;
};

/** Read-only upstream checks: background work never issues refunds or replays a POST. */
export async function checkRefund(workspaceId: string, requestId: string, repository: Repository = getRepository()) {
  return withWorkspaceLock(repository, workspaceId, async (owner) => {
    const event = repository.latestMoneyEvents(workspaceId).find((item) => item.kind === "refund" && item.requestId === requestId);
    if (!event) throw new StoreError(404, "Refund not found");
    if (["COMPLETED", "SIMULATED", "CREDIT_RESTORED", "VISIT_RETURNED"].includes(event.status)) return { kind: "settled" as const };
    // Persist before I/O so process restarts and failing requests retain their backoff.
    repository.deferRefundCheck(event);
    const outcome = await reconcileRefund(event, repository);
    repository.renewLock(workspaceId, owner);
    if (outcome.kind === "unknown") reviewUncertainRefund(event, repository);
    return outcome;
  });
}

/** One sweep across all workspaces and Next bundles in this server process. */
export function sweepRefunds(repository: Repository = getRepository(), workspaceId?: string): Promise<number> {
  if (processSweep.rebookRefundSweep) return processSweep.rebookRefundSweep;
  const run = async () => {
    const due = repository.dueRefunds(Date.now(), REFUND_SWEEP_AGE_MS, REFUND_SWEEP_CAP, workspaceId);
    let checked = 0;
    for (const event of due) {
      try { await checkRefund(event.workspaceId, event.requestId, repository); checked += 1; }
      catch (error) {
        // Busy captures must not permanently occupy every slot ahead of other workspaces.
        if (error instanceof StoreError && error.status === 409) repository.deferRefundCheck(event);
        else console.error("Refund reconciliation check failed");
      }
    }
    return checked;
  };
  const pending = run().finally(() => { if (processSweep.rebookRefundSweep === pending) processSweep.rebookRefundSweep = undefined; });
  processSweep.rebookRefundSweep = pending;
  return pending;
}

export function startRefundSweep(): void {
  if (processSweep.rebookRefundSweepTimer) return;
  const run = () => { void sweepRefunds().catch(() => console.error("Refund reconciliation sweep failed")); };
  run();
  processSweep.rebookRefundSweepTimer = setInterval(run, 60_000);
  processSweep.rebookRefundSweepTimer.unref();
}
