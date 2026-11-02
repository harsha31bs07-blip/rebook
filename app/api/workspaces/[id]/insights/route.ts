import { api, WorkspaceIdSchema } from "../../../../../lib/api/http";
import { buildInsights } from "../../../../../lib/insights/data";
import { getRepository } from "../../../../../lib/store";
import { sweepRefunds } from "../../../../../lib/executor/refund-sweep";

export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id);
    const repository = getRepository();
    const { state } = repository.requireReadyWorkspace(id);
    void sweepRefunds(repository, id).catch(() => console.error("Refund reconciliation sweep failed"));
    return buildInsights(state, repository.listPlans(id), repository.listLedger(id), repository.listCustomerLinks(id), repository.listCredits(id), repository.listCheckout(id), repository.listWaitlistOffers(id));
  });
}
