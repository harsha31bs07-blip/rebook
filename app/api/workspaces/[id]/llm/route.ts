import { api, jsonBody, WorkspaceIdSchema } from "../../../../../lib/api/http";
import { StudioChatSchema, studioCompletion } from "../../../../../lib/ai/studio-gemini";
import { getRepository } from "../../../../../lib/store";
import { clientIp } from "../../../../../lib/api/client-ip";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id);
    const { state } = getRepository().requireReadyWorkspace(id);
    // Studio's tool schemas and query results are larger than the console's small JSON bodies.
    const body = await jsonBody(request, StudioChatSchema, 65_536);
    return studioCompletion(body, request.signal, { client: clientIp(request), workspace: id }, state);
  });
}
