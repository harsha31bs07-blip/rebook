import { api, EmptyBodySchema, jsonBody, PlanIdSchema, WorkspaceIdSchema } from "../../../../../../../lib/api/http";
import { executePlan } from "../../../../../../../lib/executor/executePlan";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string; planId: string }> }): Promise<Response> {
  return api(async () => {
    const params = await context.params;
    const id = WorkspaceIdSchema.parse(params.id);
    const planId = PlanIdSchema.parse(params.planId);
    await jsonBody(request, EmptyBodySchema);
    const result = await executePlan(id, planId);
    const { basis: _basis, ...plan } = result.plan;
    void _basis;
    return { plan, results: result.results };
  });
}
