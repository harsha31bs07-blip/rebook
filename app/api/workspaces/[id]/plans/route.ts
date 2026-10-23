import { z } from "zod";
import { api, jsonBody, WorkspaceIdSchema } from "../../../../../lib/api/http";
import { DisruptionSchema } from "../../../../../lib/domain/schemas";
import { replan } from "../../../../../lib/solver/replan";
import { validate } from "../../../../../lib/solver/validate";
import { getRepository, StoreError, withWorkspaceLock } from "../../../../../lib/store";

export const runtime = "nodejs";
const InputSchema = z.strictObject({ disruption: DisruptionSchema });
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id);
    const { disruption } = await jsonBody(request, InputSchema);
    const repository = getRepository();
    repository.requireReadyWorkspace(id);
    return withWorkspaceLock(repository, id, () => {
      const state = repository.requireReadyWorkspace(id).state;
      const plan = replan(state, disruption);
      const validation = validate(state, plan);
      if (!validation.ok) throw new StoreError(409, "A valid recovery plan could not be generated");
      return repository.createPlan(id, plan);
    });
  });
}
