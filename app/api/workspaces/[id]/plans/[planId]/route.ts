import { api, PlanIdSchema, WorkspaceIdSchema } from "../../../../../../lib/api/http";
import { explainPlan } from "../../../../../../lib/ai/explain";
import { draftCustomerMessages } from "../../../../../../lib/ai/messages";
import { getRepository, StoreError, withWorkspaceLock } from "../../../../../../lib/store";

export const runtime = "nodejs";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string; planId: string }> }): Promise<Response> {
  return api(async () => {
    const params = await context.params;
    const id = WorkspaceIdSchema.parse(params.id);
    const planId = PlanIdSchema.parse(params.planId);
    const repository = getRepository();
    await withWorkspaceLock(repository, id, async () => repository.discardPlan(id, planId));
    return { discarded: true };
  });
}

export async function GET(_request: Request, context: { params: Promise<{ id: string; planId: string }> }): Promise<Response> {
  return api(async () => {
    const params = await context.params;
    const id = WorkspaceIdSchema.parse(params.id);
    const repository = getRepository();
    const workspace = repository.requireWorkspace(id);
    const planId = PlanIdSchema.parse(params.planId);
    const stored = repository.getPlan(id, planId);
    if (!stored) throw new StoreError(404, "Plan not found");
    const state = stored.basis ?? workspace.state;
    const { basis, ...plan } = stored;
    void basis;
    return { plan, explanation: await explainPlan(plan, state), messages: draftCustomerMessages(plan, state, repository.listLedger(id)), sessions: state.sessions };
  });
}
