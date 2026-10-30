import { api, jsonBody, WorkspaceIdSchema } from "../../../../../../lib/api/http";
import { getRepository } from "../../../../../../lib/store";
import { authenticateSync } from "../../../../../../lib/sync/http";
import { EventsSchema } from "../../../../../../lib/sync/schemas";
import { receiveEvents } from "../../../../../../lib/sync/service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id), repository = getRepository();
    authenticateSync(request, id, repository);
    return receiveEvents(id, await jsonBody(request, EventsSchema, 204_800), repository);
  });
}
