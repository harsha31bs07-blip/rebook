import { planCorrection } from "../solver/correction";
import { validate } from "../solver/validate";
import { getRepository, StoreError, withWorkspaceLock, type Repository, type StoredPlan } from "../store";

export function correctionOriginal(workspaceId: string, planId: string, repository: Repository, correctionId?: string): StoredPlan {
  const original = repository.getPlan(workspaceId, planId);
  if (!original) throw new StoreError(404, "Plan not found");
  if (original.correctionOf) throw new StoreError(409, "A correction cannot itself be withdrawn.");
  if (!["executed", "partially_failed"].includes(original.status)) throw new StoreError(409, "Only an approved recovery can be withdrawn.");
  if (original.correctedBy || repository.listPlans(workspaceId).some((plan) => plan.correctionOf === planId && plan.id !== correctionId)) {
    throw new StoreError(409, "This recovery already has a correction. Open that correction to review it.");
  }
  return original;
}

export async function withdrawPlan(workspaceId: string, planId: string, repository = getRepository()): Promise<StoredPlan> {
  return withWorkspaceLock(repository, workspaceId, () => {
    const state = repository.requireReadyWorkspace(workspaceId).state;
    const original = correctionOriginal(workspaceId, planId, repository);
    const started = performance.now();
    const correction = planCorrection(state, original, new Date().toISOString());
    const validation = validate(state, correction);
    if (!validation.ok) throw new StoreError(409, `A valid correction could not be generated: ${validation.errors.join("; ")}`);
    correction.planningDurationMs = performance.now() - started;
    return repository.transaction(() => { repository.discardOtherProposals(workspaceId); return repository.createPlan(workspaceId, correction); });
  });
}
