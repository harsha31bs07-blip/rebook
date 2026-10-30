import { fillFreedSeats, ownerWaitlist } from "../../../../lib/waitlist/service";
import { api, WorkspaceIdSchema } from "../../../../lib/api/http";
import { getRepository } from "../../../../lib/store";
import { ownerCustomerChoices } from "../../../../lib/choices/service";
import { sweepRefunds } from "../../../../lib/executor/refund-sweep";
import { paymentsNeedingAttention } from "../../../../lib/recovery/payment-attention";
import { ownerCovers } from "../../../../lib/recovery/cover-pay";
import { ownerSync } from "../../../../lib/sync/service";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id);
    const repository = getRepository();
    const workspace = repository.requireWorkspace(id);
    void sweepRefunds(repository, id).catch(() => console.error("Refund reconciliation sweep failed"));
    if (workspace.status === "ready") fillFreedSeats(id, repository);
    const plans = repository.listPlans(id, 20).map(({ basis: _basis, ...plan }) => { void _basis; return plan; });
    return { ...workspace, waitlist: ownerWaitlist(id, repository), plans, ledger: repository.listLedger(id, 500), ledgerSummary: repository.ledgerSummary(id), customerChoices: ownerCustomerChoices(id, repository), covers: ownerCovers(id, repository),
      paymentsNeedingAttention: paymentsNeedingAttention(workspace.state, repository.latestMoneyEvents(id)), sync: ownerSync(id, repository) };
  });
}
