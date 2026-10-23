import { api, EmptyBodySchema, json, jsonBody, rateLimitCreation } from "../../../lib/api/http";
import { beginWorkspace } from "../../../lib/demo/createWorkspace";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  return api(async () => {
    await jsonBody(request, EmptyBodySchema);
    rateLimitCreation(request);
    const workspace = beginWorkspace();
    return json({ id: workspace.id }, 202);
  });
}
