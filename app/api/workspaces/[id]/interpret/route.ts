import { z } from "zod";
import { api, jsonBody, WorkspaceIdSchema } from "../../../../../lib/api/http";
import { InterpretationError, interpretDisruption } from "../../../../../lib/ai/interpret";
import { getRepository, StoreError } from "../../../../../lib/store";

export const runtime = "nodejs";
const InputSchema = z.strictObject({ text: z.string().max(500).trim().min(1) });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id);
    const { text } = await jsonBody(request, InputSchema);
    const state = getRepository().requireWorkspace(id).state;
    try {
      return await interpretDisruption(text, state, new Date().toISOString(), state.studio.weekStart);
    } catch (error) {
      if (error instanceof InterpretationError) throw new StoreError(422, error.message);
      throw error;
    }
  });
}
