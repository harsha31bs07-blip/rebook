import { applyPlan, validate } from "../solver/validate";
import { activateConstraint } from "../solver/constraints";
import { executeRefund } from "./refund";
import { createCustomerLinks } from "../choices/service";
import { getRepository, StoreError, withWorkspaceLock, type ExecutionResult, type Repository, type StoredPlan } from "../store";

/** A durable REQUESTED event precedes every refund. Crash recovery uses the same PayPal request ID. */
export async function executePlan(workspaceId: string, planId: string, repository: Repository = getRepository(), expectedVersion?: number): Promise<{ plan: StoredPlan; results: ExecutionResult[] }> {
  repository.requireReadyWorkspace(workspaceId);
  return withWorkspaceLock(repository, workspaceId, async (owner) => {
    let plan = repository.getPlan(workspaceId, planId);
    if (!plan) throw new StoreError(404, "Plan not found");
    if (expectedVersion !== undefined && expectedVersion !== (plan.version ?? 1)) throw new StoreError(409, "This plan changed. Reload the preview before approving.", "stale_plan");
    if (plan.status === "executed") return { plan, results: plan.results };
    const workspace = repository.requireReadyWorkspace(workspaceId);
    if (plan.status !== "proposed" && (!["executing", "partially_failed"].includes(plan.status) || !plan.basis)) throw new StoreError(409, "Plan cannot be executed");
    const basis = plan.status === "proposed" ? workspace.state : plan.basis!;
    const validation = validate(basis, plan);
    if (!validation.ok) throw new StoreError(409, `Plan is no longer valid: ${validation.errors.join("; ")}`);
    if (plan.status === "proposed") {
      // Preserve existing terminal money states when applying the pure scheduling transformation.
      const next = activateConstraint(applyPlan(workspace.state, plan), plan.disruption);
      for (const booking of next.bookings) {
        const previous = workspace.state.bookings.find((item) => item.id === booking.id)!;
        if (["refunded", "refund_pending", "cancelled"].includes(previous.status)) booking.status = previous.status;
      }
      plan = { ...plan, status: "executing", basis };
      repository.transaction(() => { repository.saveState(workspaceId, next); repository.savePlan(plan!); createCustomerLinks(plan!, basis, next, repository); });
    } else {
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
