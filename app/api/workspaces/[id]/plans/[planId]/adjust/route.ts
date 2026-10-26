import { z } from "zod";
import { api, jsonBody, PlanIdSchema, WorkspaceIdSchema } from "../../../../../../../lib/api/http";
import { IsoSchema } from "../../../../../../../lib/domain/schemas";
import { adjustPlan } from "../../../../../../../lib/solver/adjust";
import { planTimeErrors, validate } from "../../../../../../../lib/solver/validate";
import { getRepository, StoreError, withWorkspaceLock } from "../../../../../../../lib/store";

export const runtime = "nodejs";
const version = z.number().int().positive().optional().default(1);
const InputSchema = z.union([
  z.strictObject({ sessionId: z.string().min(1), start: IsoSchema, instructorId: z.string().min(1).optional(), roomId: z.string().min(1).optional(), version }),
  z.strictObject({ undo: z.literal(true), version }),
]);

export async function POST(request: Request, context: { params: Promise<{ id: string; planId: string }> }): Promise<Response> {
  return api(async () => {
    const params = await context.params;
    const id = WorkspaceIdSchema.parse(params.id);
    const repository = getRepository();
    repository.requireReadyWorkspace(id);
    const planId = PlanIdSchema.parse(params.planId);
    const input = await jsonBody(request, InputSchema);
    return withWorkspaceLock(repository, id, () => {
      const state = repository.requireReadyWorkspace(id).state;
      const stored = repository.getPlan(id, planId);
      if (!stored) throw new StoreError(404, "Plan not found");
      if (input.version !== (stored.version ?? 1)) throw new StoreError(409, "This plan changed. Reload the preview before adjusting.", "stale_plan");
      if (stored.status !== "proposed") throw new StoreError(409, "Only a recovery preview can be adjusted.");
      try {
        const previous = "undo" in input ? stored.lastAdjustment : stored.sessionChanges.find((item) => item.sessionId === input.sessionId);
        if ("undo" in input && !previous?.after) throw new Error("There is no adjustment to undo.");
        const next = adjustPlan(state, stored, "undo" in input
          ? { sessionId: previous!.sessionId, ...previous!.after! } : input);
        if ("undo" in input) next.sessionChanges = next.sessionChanges.map((item) => item.sessionId === previous!.sessionId ? previous! : item);
        if (planTimeErrors(next, Date.now()).length) throw new Error("This recovery preview has expired. Plan a fresh recovery before adjusting.");
        const validation = validate(state, next);
        if (!validation.ok) throw new Error(validation.errors.join("; "));
        const saved = { ...stored, ...next, version: (stored.version ?? 1) + 1,
          lastAdjustment: "undo" in input ? undefined : previous,
          lastAdjustmentTotals: "undo" in input ? undefined : stored.totals };
        repository.savePlan(saved);
        const { basis: _basis, ...plan } = saved;
        void _basis;
        return plan;
      } catch (error) {
        throw new StoreError(422, error instanceof Error ? error.message : "This placement is unavailable.");
      }
    });
  });
}
