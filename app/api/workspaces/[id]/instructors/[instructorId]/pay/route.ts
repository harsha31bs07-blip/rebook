import { z } from "zod";
import { api, jsonBody, WorkspaceIdSchema } from "../../../../../../../lib/api/http";
import { limits } from "../../../../../../../lib/api/limits";
import { isSameOrigin } from "../../../../../../../lib/api/same-origin";
import { updateInstructorPay } from "../../../../../../../lib/recovery/cover-pay";
import { PayRuleUpdateSchema } from "../../../../../../../lib/recovery/pay-rules";
import { getRepository, StoreError } from "../../../../../../../lib/store";

export async function PATCH(request: Request, context: { params: Promise<{ id: string; instructorId: string }> }): Promise<Response> {
  return api(async () => {
    if (!isSameOrigin(request)) throw new StoreError(403, "Please open the owner console to set a pay rule.");
    const params = await context.params, id = WorkspaceIdSchema.parse(params.id);
    const instructorId = z.string().min(1).max(100).parse(params.instructorId);
    getRepository().requireReadyWorkspace(id);
    const input = await jsonBody(request, PayRuleUpdateSchema, 512);
    limits.take([{ key: `instructor-pay:${id}`, max: 20, ms: 60_000 }]);
    return updateInstructorPay(id, instructorId, input);
  });
}
