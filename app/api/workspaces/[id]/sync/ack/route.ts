import { api, jsonBody, WorkspaceIdSchema } from "../../../../../../lib/api/http";
import { getRepository } from "../../../../../../lib/store";
import { authenticateSync } from "../../../../../../lib/sync/http";
import { AckSchema } from "../../../../../../lib/sync/schemas";
import { acknowledge } from "../../../../../../lib/sync/service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id), repository = getRepository();
    authenticateSync(request, id, repository);
    const { ids } = await jsonBody(request, AckSchema, 204_800);
    return acknowledge(id, ids, repository);
  });
}
