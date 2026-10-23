import { api, EmptyBodySchema, jsonBody, rateLimitCreation, WorkspaceIdSchema } from "../../../../../lib/api/http";
import { resetWorkspace } from "../../../../../lib/demo/createWorkspace";
import { getRepository } from "../../../../../lib/store";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id);
    await jsonBody(request, EmptyBodySchema);
    getRepository().requireWorkspace(id);
    rateLimitCreation(request);
    const workspace = await resetWorkspace(id);
    return { id: workspace.id };
  });
}
