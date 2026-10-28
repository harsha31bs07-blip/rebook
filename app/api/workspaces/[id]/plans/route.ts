import { z } from "zod";
import { api, jsonBody, WorkspaceIdSchema } from "../../../../../lib/api/http";
import { DisruptionSchema } from "../../../../../lib/domain/schemas";
import { addLocalDays, localParts, zonedTimeToUtc } from "../../../../../lib/domain/time";
import { replan } from "../../../../../lib/solver/replan";
import { validate } from "../../../../../lib/solver/validate";
import { getRepository, StoreError, withWorkspaceLock } from "../../../../../lib/store";
import { limits } from "../../../../../lib/api/limits";

export const runtime = "nodejs";
const InputSchema = z.strictObject({ disruption: DisruptionSchema });
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id);
    const repository = getRepository();
    repository.requireReadyWorkspace(id);
    const { disruption } = await jsonBody(request, InputSchema);
    limits.take([{ key: `plans:${id}`, max: 6, ms: 60_000 }]);
    return withWorkspaceLock(repository, id, () => {
      const state = repository.requireReadyWorkspace(id).state;
      const now = new Date().toISOString();
      const { timezone, weekStart } = state.studio;
      const horizonEnd = zonedTimeToUtc(addLocalDays(localParts(weekStart, timezone).dateKey, 7), "00:00", timezone);
      if (Date.parse(disruption.from) < Date.parse(weekStart) || Date.parse(disruption.to) > Date.parse(horizonEnd)) {
        throw new StoreError(400, "Choose a disruption within this studio week.");
      }
      const started = performance.now();
      const plan = replan(state, disruption, { now, horizonEnd });
      const validation = validate(state, plan);
      if (!validation.ok) throw new StoreError(409, "A valid recovery plan could not be generated");
      plan.planningDurationMs = performance.now() - started;
      return repository.transaction(() => { repository.discardOtherProposals(id); return repository.createPlan(id, plan); });
    });
  });
}
