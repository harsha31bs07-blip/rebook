import { api, WorkspaceIdSchema } from "../../../../lib/api/http";
import { getRepository } from "../../../../lib/store";
import { ownerCustomerChoices } from "../../../../lib/choices/service";
import { sweepRefunds } from "../../../../lib/executor/refund-sweep";
import { paymentsNeedingAttention } from "../../../../lib/recovery/payment-attention";

export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id);
    const repository = getRepository();
    const workspace = repository.requireWorkspace(id);
    void sweepRefunds(repository, id).catch(() => console.error("Refund reconciliation sweep failed"));
    const plans = repository.listPlans(id, 20).map(({ basis: _basis, ...plan }) => { void _basis; return plan; });
    return { ...workspace, plans, ledger: repository.listLedger(id, 500), ledgerSummary: repository.ledgerSummary(id), customerChoices: ownerCustomerChoices(id, repository),
      paymentsNeedingAttention: paymentsNeedingAttention(workspace.state, repository.latestMoneyEvents(id)) };
  });
}
