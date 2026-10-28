import { z } from "zod";
import { api, jsonBody, PlanIdSchema, WorkspaceIdSchema } from "../../../../../../lib/api/http";
import { clientIp } from "../../../../../../lib/api/client-ip";
import { isSameOrigin, publicOrigin } from "../../../../../../lib/api/same-origin";
import { sendCustomerEmail } from "../../../../../../lib/choices/email";
import { StoreError } from "../../../../../../lib/store";

export const runtime = "nodejs";
const InputSchema = z.strictObject({ planId: PlanIdSchema, customerId: z.string().min(1).max(100), reminder: z.boolean().optional(), resend: z.boolean().optional() });
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    if (!isSameOrigin(request)) throw new StoreError(403, "Please open the owner console to send email.");
    const id = WorkspaceIdSchema.parse((await context.params).id), input = await jsonBody(request, InputSchema, 1024);
    return sendCustomerEmail(id, input, publicOrigin(request), clientIp(request));
  });
}
