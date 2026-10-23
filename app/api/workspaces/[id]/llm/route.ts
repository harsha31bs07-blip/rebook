import { api, WorkspaceIdSchema } from "../../../../../lib/api/http";
import { rateLimitStudio, StudioChatSchema, studioCompletion } from "../../../../../lib/ai/studio-gemini";
import { getRepository, StoreError } from "../../../../../lib/store";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id);
    getRepository().requireReadyWorkspace(id);
    rateLimitStudio(id);
    // Studio's tool schemas and query results are larger than the console's small JSON bodies.
    const raw = await request.text();
    if (raw.length > 1_048_576) throw new StoreError(413, "This conversation is too large. Please start a new conversation.");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new StoreError(400, "Invalid JSON"); }
    return studioCompletion(StudioChatSchema.parse(parsed), request.signal);
  });
}
