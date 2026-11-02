import { z } from "zod";
import { api, jsonBody, WorkspaceIdSchema } from "../../../../../../lib/api/http";
import { limits } from "../../../../../../lib/api/limits";
import { getRepository } from "../../../../../../lib/store";
import { checkRefund } from "../../../../../../lib/executor/refund-sweep";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id);
    const repository = getRepository();
    repository.requireReadyWorkspace(id);
    const { requestId } = await jsonBody(request, z.strictObject({ requestId: z.string().min(1).max(200) }));
    limits.take([{ key: `refund-check:${id}`, max: 10, ms: 60_000 }]);
    const result = await checkRefund(id, requestId, repository);
    return { kind: result.kind };
  });
}
