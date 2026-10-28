import { z } from "zod";
import { api, jsonBody, PlanIdSchema, WorkspaceIdSchema } from "../../../../../../../lib/api/http";
import { isSameOrigin } from "../../../../../../../lib/api/same-origin";
import { refreshEmailStatus } from "../../../../../../../lib/choices/email";
import { StoreError } from "../../../../../../../lib/store";

export const runtime = "nodejs";
const InputSchema = z.strictObject({ planId: PlanIdSchema });
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    if (!isSameOrigin(request)) throw new StoreError(403, "Please open the owner console to check email.");
    const id = WorkspaceIdSchema.parse((await context.params).id);
    await jsonBody(request, InputSchema, 1024);
    return refreshEmailStatus(id);
  });
}
