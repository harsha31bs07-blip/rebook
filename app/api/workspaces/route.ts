import { api, EmptyBodySchema, json, jsonBody, rateLimitCreation } from "../../../lib/api/http";
import { createWorkspace } from "../../../lib/demo/createWorkspace";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  return api(async () => {
    await jsonBody(request, EmptyBodySchema);
    rateLimitCreation(request);
    const workspace = await createWorkspace();
    return json({ id: workspace.id }, 201);
  });
}
