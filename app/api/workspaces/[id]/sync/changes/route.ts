import { api, WorkspaceIdSchema } from "../../../../../../lib/api/http";
import { getRepository } from "../../../../../../lib/store";
import { authenticateSync } from "../../../../../../lib/sync/http";
import { changeFeed } from "../../../../../../lib/sync/feed";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id), repository = getRepository();
    authenticateSync(request, id, repository);
    return changeFeed(id, repository);
  });
}
