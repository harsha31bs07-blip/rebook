import { z } from "zod";
import { api, jsonBody, PlanIdSchema, WorkspaceIdSchema } from "../../../../../../lib/api/http";
import { limits } from "../../../../../../lib/api/limits";
import { isSameOrigin } from "../../../../../../lib/api/same-origin";
import { askNextCover } from "../../../../../../lib/recovery/cover-pay";
import { getRepository, StoreError } from "../../../../../../lib/store";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    if (!isSameOrigin(request)) throw new StoreError(403, "Please open the owner console to change a cover.");
    const id = WorkspaceIdSchema.parse((await context.params).id);
    getRepository().requireReadyWorkspace(id);
    const { planId, sessionId } = await jsonBody(request, z.strictObject({ planId: PlanIdSchema, sessionId: z.string().min(1).max(100) }), 512);
    limits.take([{ key: `cover-next:${id}`, max: 10, ms: 60_000 }]);
    return askNextCover(id, planId, sessionId);
  });
}
