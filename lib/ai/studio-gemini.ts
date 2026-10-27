import { z } from "zod";
import type { AiIdentity } from "./gemini";
import type { State } from "../domain/types";
import { studioInstructions, studioToolNames, studioTools } from "./studio-policy";
import { studioModelCompletion } from "./studio-transport";
import { studioRequestFits, STUDIO_REQUEST_TOO_LARGE, withThoughtSignatures } from "./studio-request";

const ToolCallSchema = z.object({
  id: z.string(), type: z.literal("function"),
  function: z.object({ name: z.string().refine((name) => studioToolNames.has(name), "Unknown tool"), arguments: z.string() }),
  extra_content: z.record(z.string(), z.unknown()).optional(),
});
export const StudioChatSchema = z.strictObject({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant", "tool"]), content: z.string().nullable(),
    tool_call_id: z.string().optional(), tool_calls: z.array(ToolCallSchema).optional(),
  })).min(1).max(60),
  model: z.string().optional(),
}).refine(studioRequestFits, STUDIO_REQUEST_TOO_LARGE);
export type StudioChatRequest = z.infer<typeof StudioChatSchema>;
export const StudioCompletionSchema = z.object({
  id: z.string(), model: z.string().optional(), created: z.number().optional(),
  choices: z.array(z.object({ message: z.object({
    role: z.literal("assistant"), content: z.string().nullable().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
  }), finish_reason: z.string().nullable().optional() })).min(1),
});
export type StudioCompletion = z.infer<typeof StudioCompletionSchema>;

export async function studioCompletion(body: StudioChatRequest, signal?: AbortSignal, identity?: AiIdentity, state?: State): Promise<StudioCompletion> {
  body = StudioChatSchema.parse(body);
  return studioModelCompletion(body.model, signal, identity,
    (model) => ({ messages: [{ role: "system", content: studioInstructions(state) }, ...withThoughtSignatures(body.messages)], tools: studioTools, model, stream: false, max_tokens: 4096 }),
    (value) => {
      const completion = StudioCompletionSchema.parse(value);
      const message = completion.choices[0].message;
      if (!message.content && !message.tool_calls?.length) throw new Error("Empty completion");
      return completion;
    });
}
