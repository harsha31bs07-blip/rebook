import { api, EmptyBodySchema, json, jsonBody, rateLimitCreation } from "../../../lib/api/http";
import { beginWorkspace, startWarmPool } from "../../../lib/demo/createWorkspace";
import { getRepository, StoreError } from "../../../lib/store";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  return api(async () => {
    await jsonBody(request, EmptyBodySchema);
    try { rateLimitCreation(request); }
    catch (error) {
      if (!(error instanceof StoreError) || error.status !== 429) throw error;
      const repository = getRepository();
      const pooled = process.env.DEMO_WARM_POOL === "1" ? repository.claimPoolWorkspace() : undefined;
      if (!pooled) throw error;
      void startWarmPool(repository);
      return json({ id: pooled.id }, 202);
    }
    const workspace = beginWorkspace();
    return json({ id: workspace.id }, 202);
  });
}
