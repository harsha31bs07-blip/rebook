import { applyPlan, planTimeErrors, validate } from "../solver/validate";
import { activateConstraint } from "../solver/constraints";
import { executeRefund } from "./refund";
import { reconcileRefund } from "./reconcileRefund";
import { createCustomerLinks } from "../choices/service";
import { planCovers } from "../recovery/covers";
import { getRepository, StoreError, withWorkspaceLock, type ExecutionResult, type Repository, type StoredPlan } from "../store";

/** A durable REQUESTED event precedes every refund. Crash recovery uses the same PayPal request ID. */
export async function executePlan(workspaceId: string, planId: string, repository: Repository = getRepository(), expectedVersion?: number, confirmedCoverSessionIds: string[] = []): Promise<{ plan: StoredPlan; results: ExecutionResult[] }> {
  repository.requireReadyWorkspace(workspaceId);
  return withWorkspaceLock(repository, workspaceId, async (owner) => {
    let plan = repository.getPlan(workspaceId, planId);
    if (!plan) throw new StoreError(404, "Plan not found");
    if (expectedVersion !== undefined && expectedVersion !== (plan.version ?? 1)) throw new StoreError(409, "This plan changed. Reload the preview before approving.", "stale_plan");
    if (plan.status === "executed") {
      // Settlement checks must not reapply the schedule or start another refund.
      for (const result of plan.results.filter((item) => item.status === "PENDING")) {
        const event = repository.latestMoneyEvents(workspaceId).find((item) => item.kind === "refund" && item.requestId === `${planId}:${result.bookingId}`);
        if (!event || event.status !== "PENDING") continue;
        repository.renewLock(workspaceId, owner);
        await reconcileRefund(event, repository);
        repository.renewLock(workspaceId, owner);
      }
      const view = repository.getPlan(workspaceId, planId)!;
      return { plan: view, results: view.results };
    }
    const workspace = repository.requireReadyWorkspace(workspaceId);
    if (plan.status !== "proposed" && (!["executing", "partially_failed"].includes(plan.status) || !plan.basis)) throw new StoreError(409, "Plan cannot be executed");
    const basis = plan.status === "proposed" ? workspace.state : plan.basis!;
    if (plan.status === "proposed") {
      if (repository.listCheckout(workspaceId).some((row) => row.status === "capturing")) throw new StoreError(409, "A customer payment is still being reconciled. Check its status, then refresh the recovery preview.", "CHECK_PAYMENT_STATUS");
      if (planTimeErrors(plan, Date.now()).length) throw new StoreError(409, "This recovery preview has expired. Plan a fresh recovery before approving.", "PLAN_EXPIRED");
    }
    if (plan.status === "proposed") {
      const validation = validate(basis, plan);
      if (!validation.ok) throw new StoreError(409, `Plan is no longer valid: ${validation.errors.join("; ")}`);
      // Preserve existing terminal money states when applying the pure scheduling transformation.
      const next = activateConstraint(applyPlan(workspace.state, plan), plan.disruption);
      for (const booking of next.bookings) {
        const previous = workspace.state.bookings.find((item) => item.id === booking.id)!;
        if (["refunded", "refund_pending", "cancelled"].includes(previous.status)) booking.status = previous.status;
      }
      const covers = planCovers(plan, basis);
      if (confirmedCoverSessionIds.some((id) => !covers.some((cover) => cover.sessionId === id))) throw new StoreError(400, "A cover confirmation does not match this recovery preview.");
      const coverConfirmations = covers.filter((cover) => confirmedCoverSessionIds.includes(cover.sessionId)).map((cover) => ({
        sessionId: cover.sessionId, instructorId: cover.instructorId, confirmedBy: "Workspace owner", confirmedAt: new Date().toISOString(),
      }));
      plan = { ...plan, status: "executing", basis, coverConfirmations };
      repository.transaction(() => { repository.saveState(workspaceId, next); repository.savePlan(plan!); createCustomerLinks(plan!, basis, next, repository); });
    } else {
      // Scheduling rules apply at approval; retries settle the already-approved money actions.
      plan = { ...plan, status: "executing" };
      repository.savePlan(plan);
    }
    createCustomerLinks(plan, basis, repository.requireWorkspace(workspaceId).state, repository);
    const actions = plan.bookingActions.filter((item) => item.action === "refund");
    const ordered: (ExecutionResult | undefined)[] = actions.map(() => undefined);
    let next = 0, done = 0;
    let stopped = false;
    plan = { ...plan, refundProgress: { done, total: actions.length } };
    repository.savePlan(plan);
    const worker = async () => {
      while (!stopped && next < actions.length) {
        const index = next++, action = actions[index];
        try {
          repository.renewLock(workspaceId, owner);
          ordered[index] = await executeRefund(workspaceId, action, `${planId}:${action.bookingId}`, repository,
            () => repository.renewLock(workspaceId, owner));
          repository.renewLock(workspaceId, owner);
          done += 1;
          plan = { ...plan!, results: ordered.filter((item): item is ExecutionResult => !!item), refundProgress: { done, total: actions.length } };
          repository.savePlan(plan);
        } catch (error) { stopped = true; throw error; }
      }
    };
    // Join every in-flight request before releasing the lease, even after a worker fails.
    const workers = await Promise.allSettled(Array.from({ length: Math.min(3, actions.length) }, worker));
    const failed = workers.find((item) => item.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    repository.renewLock(workspaceId, owner);
    const results = ordered.filter((item): item is ExecutionResult => !!item);
    plan = { ...plan, results, status: results.some((result) => !["COMPLETED", "PENDING", "SIMULATED"].includes(result.status)) ? "partially_failed" : "executed" };
    repository.savePlan(plan);
    const view = repository.getPlan(workspaceId, planId)!;
    return { plan: view, results: view.results };
  });
}
