import { api, jsonBody, WorkspaceIdSchema } from "../../../../../lib/api/http";
import { RecoveryHarnessSchema, recoveryCompletion } from "../../../../../lib/insights/llm";
import { StudioChatSchema } from "../../../../../lib/ai/studio-gemini";
import { getRepository } from "../../../../../lib/store";
import { clientIp } from "../../../../../lib/api/client-ip";
import { STUDIO_REQUEST_BYTES } from "../../../../../lib/ai/studio-request";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id);
    const { state } = getRepository().requireReadyWorkspace(id);
    // Studio's tool schemas and query results are larger than the console's small JSON bodies.
    const harness = request.headers.get("X-Rebook-Studio") === "harness";
    const body = harness ? await jsonBody(request, RecoveryHarnessSchema, STUDIO_REQUEST_BYTES) : await jsonBody(request, StudioChatSchema, STUDIO_REQUEST_BYTES);
    return recoveryCompletion(body, request.signal, { client: clientIp(request), workspace: id }, state);
  });
}
