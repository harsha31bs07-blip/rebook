import { api, EmptyBodySchema, jsonBody, PlanIdSchema, WorkspaceIdSchema } from "../../../../../../../lib/api/http";
import { limits } from "../../../../../../../lib/api/limits";
import { isSameOrigin } from "../../../../../../../lib/api/same-origin";
import { withdrawPlan } from "../../../../../../../lib/recovery/correction";
import { StoreError } from "../../../../../../../lib/store";

export async function POST(request: Request, context: { params: Promise<{ id: string; planId: string }> }): Promise<Response> {
  return api(async () => {
    if (!isSameOrigin(request)) throw new StoreError(403, "Cross-origin requests are not allowed.");
    const params = await context.params;
    const id = WorkspaceIdSchema.parse(params.id), planId = PlanIdSchema.parse(params.planId);
    await jsonBody(request, EmptyBodySchema);
    limits.take([{ key: `plans:${id}`, max: 6, ms: 60_000 }]);
    const { basis, ...plan } = await withdrawPlan(id, planId);
    void basis;
    return plan;
  });
}
