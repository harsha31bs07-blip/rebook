import { applyPlan, planTimeErrors, validate } from "../solver/validate";
import { activateConstraint } from "../solver/constraints";
import { executeRefund } from "./refund";
import { reconcileRefund } from "./reconcileRefund";
import { createCustomerLinks } from "../choices/service";
import { getRepository, StoreError, withWorkspaceLock, type ExecutionResult, type Repository, type StoredPlan } from "../store";

/** A durable REQUESTED event precedes every refund. Crash recovery uses the same PayPal request ID. */
export async function executePlan(workspaceId: string, planId: string, repository: Repository = getRepository(), expectedVersion?: number): Promise<{ plan: StoredPlan; results: ExecutionResult[] }> {
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
      plan = { ...plan, status: "executing", basis };
      repository.transaction(() => { repository.saveState(workspaceId, next); repository.savePlan(plan!); createCustomerLinks(plan!, basis, next, repository); });
    } else {
      // Scheduling rules apply at approval; retries settle the already-approved money actions.
      plan = { ...plan, status: "executing" };
      repository.savePlan(plan);
    }
    createCustomerLinks(plan, basis, repository.requireWorkspace(workspaceId).state, repository);
    const results: ExecutionResult[] = [];
    for (const action of plan.bookingActions.filter((item) => item.action === "refund")) {
      repository.renewLock(workspaceId, owner);
      const result = await executeRefund(workspaceId, action, `${planId}:${action.bookingId}`, repository,
        () => repository.renewLock(workspaceId, owner));
      results.push(result);
      plan = { ...plan, results: [...results] };
      repository.savePlan(plan);
    }
    plan = { ...plan, results, status: results.some((result) => !["COMPLETED", "PENDING", "SIMULATED"].includes(result.status)) ? "partially_failed" : "executed" };
    repository.savePlan(plan);
    const view = repository.getPlan(workspaceId, planId)!;
    return { plan: view, results: view.results };
  });
}
