import { z } from "zod";
import { api, jsonBody, PlanIdSchema, WorkspaceIdSchema } from "../../../../../lib/api/http";
import { isSameOrigin } from "../../../../../lib/api/same-origin";
import { markCustomerContact } from "../../../../../lib/choices/service";
import { StoreError } from "../../../../../lib/store";

export const runtime = "nodejs";
const InputSchema = z.strictObject({ planId: PlanIdSchema, customerId: z.string().min(1).max(100), sent: z.boolean() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    if (!isSameOrigin(request)) throw new StoreError(403, "Please open the owner console to update the outbox.");
    const id = WorkspaceIdSchema.parse((await context.params).id);
    const input = await jsonBody(request, InputSchema, 1024);
    return markCustomerContact(id, input.planId, input.customerId, input.sent);
  });
}
