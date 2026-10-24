import { api, EmptyBodySchema, jsonBody, PlanIdSchema, WorkspaceIdSchema } from "../../../../../../../lib/api/http";
import { executePlan } from "../../../../../../../lib/executor/executePlan";
import { limits, envLimit } from "../../../../../../../lib/api/limits";
import { getRepository } from "../../../../../../../lib/store";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string; planId: string }> }): Promise<Response> {
  return api(async () => {
    const params = await context.params;
    const id = WorkspaceIdSchema.parse(params.id);
    getRepository().requireWorkspace(id);
    const planId = PlanIdSchema.parse(params.planId);
    await jsonBody(request, EmptyBodySchema);
    limits.take([{ key: "approvals", max: envLimit("MAX_APPROVALS_PER_MIN", 20), ms: 60_000 }]);
    const result = await executePlan(id, planId);
    const { basis: _basis, ...plan } = result.plan;
    void _basis;
    return { plan, results: result.results };
  });
}
