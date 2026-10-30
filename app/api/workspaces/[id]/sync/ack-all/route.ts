import { api, EmptyBodySchema, jsonBody, WorkspaceIdSchema } from "../../../../../../lib/api/http";
import { isSameOrigin } from "../../../../../../lib/api/same-origin";
import { clientIp } from "../../../../../../lib/api/client-ip";
import { limits } from "../../../../../../lib/api/limits";
import { getRepository, StoreError } from "../../../../../../lib/store";
import { acknowledge } from "../../../../../../lib/sync/service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    if (!isSameOrigin(request)) throw new StoreError(403, "Cross-origin request blocked");
    const id = WorkspaceIdSchema.parse((await context.params).id), repository = getRepository();
    repository.requireWorkspace(id);
    limits.take([{ key: `sync-owner:${id}:${clientIp(request)}`, max: 60, ms: 60_000 }]);
    await jsonBody(request, EmptyBodySchema);
    return acknowledge(id, undefined, repository);
  });
}
