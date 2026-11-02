import { z } from "zod";
import { api, jsonBody, WorkspaceIdSchema } from "../../../../../../lib/api/http";
import { limits } from "../../../../../../lib/api/limits";
import { isSameOrigin } from "../../../../../../lib/api/same-origin";
import { getRepository, StoreError, withWorkspaceLock } from "../../../../../../lib/store";
import { executeRefund } from "../../../../../../lib/executor/refund";
import { retryChoiceRefund } from "../../../../../../lib/choices/service";
import { executePlan } from "../../../../../../lib/executor/executePlan";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    if (!isSameOrigin(request)) throw new StoreError(403, "Please open the owner console to retry a refund.");
    const id = WorkspaceIdSchema.parse((await context.params).id);
    const repository = getRepository();
    repository.requireReadyWorkspace(id);
    const { requestId } = await jsonBody(request, z.strictObject({ requestId: z.string().min(1).max(200) }));
    limits.take([{ key: `refund-retry:${id}`, max: 10, ms: 60_000 }]);
    if (requestId.startsWith("choice:")) {
      const receipt = await retryChoiceRefund(id, requestId, repository);
      return { status: receipt?.status ?? "REQUESTED" };
    }
    if (requestId.startsWith("waitlist:")) {
      return withWorkspaceLock(repository, id, async (owner) => {
        const row = repository.listCheckout(id).find((item) => requestId === `waitlist:${item.id}` && item.waitlistOfferId);
        const event = repository.latestMoneyEvents(id).find((item) => item.kind === "refund" && item.requestId === requestId);
        if (!row || !event || row.status !== "confirmed") throw new StoreError(404, "Refund not found");
        return executeRefund(id, { bookingId: row.id, amount: row.amount, reason: "Waitlist spot no longer available" }, requestId, repository,
          () => repository.renewLock(id, owner));
      });
    }
    // Approved-plan refunds retry through the plan, which keeps its results in step.
    const plan = repository.listPlans(id).find((item) => requestId.startsWith(`${item.id}:`));
    if (!plan) throw new StoreError(404, "Refund not found");
    if (plan.status !== "partially_failed") throw new StoreError(409, "This refund has no failed recovery to retry.");
    const { results } = await executePlan(id, plan.id, repository);
    return { status: results.find((result) => requestId === `${plan.id}:${result.bookingId}`)?.status ?? "REQUESTED" };
  });
}
