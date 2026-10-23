import { z } from "zod";
import { StoreError } from "../store";

const ToolCallSchema = z.object({
  id: z.string(), type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
  extra_content: z.record(z.string(), z.unknown()).optional(),
});
export const StudioChatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]), content: z.string().nullable(),
    tool_call_id: z.string().optional(), tool_calls: z.array(ToolCallSchema).optional(),
  })).min(1).max(300),
  tools: z.array(z.object({ type: z.literal("function"), function: z.object({
    name: z.string(), description: z.string().optional(), parameters: z.record(z.string(), z.unknown()),
  }) })).max(100).optional(),
  tool_choice: z.union([z.enum(["auto", "none", "required"]), z.object({ type: z.literal("function"), function: z.object({ name: z.string() }) })]).optional(),
  response_format: z.object({ type: z.literal("json_schema"), json_schema: z.object({ name: z.string(), schema: z.record(z.string(), z.unknown()) }) }).optional(),
  model: z.string().optional(),
});
export type StudioChatRequest = z.infer<typeof StudioChatSchema>;
export const StudioCompletionSchema = z.object({
  id: z.string(), model: z.string().optional(), created: z.number().optional(),
  choices: z.array(z.object({ message: z.object({
    role: z.literal("assistant"), content: z.string().nullable().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
  }), finish_reason: z.string().nullable().optional() })).min(1),
});
export type StudioCompletion = z.infer<typeof StudioCompletionSchema>;

const attempts = new Map<string, { count: number; expiresAt: number }>();
export function rateLimitStudio(id: string) {
  const now = Date.now();
  for (const [key, bucket] of attempts) if (bucket.expiresAt <= now) attempts.delete(key);
  const bucket = attempts.get(id) ?? { count: 0, expiresAt: now + 600_000 };
  if (bucket.count >= 30) throw new StoreError(429, "The analyst has reached 30 turns. Please try again in a few minutes.");
  bucket.count++;
  attempts.set(id, bucket);
}

export async function studioCompletion(body: StudioChatRequest, signal?: AbortSignal): Promise<StudioCompletion> {
  const unavailable = () => new StoreError(503, "The recovery analyst is temporarily unavailable. Your insights are still available; please try again shortly.");
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw unavailable();
  const configured = (process.env.GEMINI_MODELS || "gemini-flash-lite-latest,gemini-3.5-flash,gemini-flash-latest").split(",").map((model) => model.trim()).filter(Boolean);
  const models = body.model && configured.includes(body.model) ? [body.model, ...configured.filter((model) => model !== body.model)] : configured;
  const started = Date.now();
  for (const model of models) {
    if (signal?.aborted) break;
    const remaining = 25_000 - (Date.now() - started);
    if (remaining <= 0) break;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, Math.min(12_000, remaining));
      });
      const result = await Promise.race([
        (async () => {
          const response = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
            method: "POST", cache: "no-store", signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({ ...body, model, stream: false, max_tokens: 4096 }),
          });
          if (!response.ok) return { permanent: response.status === 401 || response.status === 403 };
          const completion = StudioCompletionSchema.parse(await response.json());
          const choice = completion.choices[0];
          if (!choice.message.content && !choice.message.tool_calls?.length) throw unavailable();
          return { completion };
        })(), deadline,
      ]);
      if (result.completion) return result.completion;
      if (result.permanent) break;
    } catch {
      // Never return/log upstream bodies, auth headers, or credentials.
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  throw unavailable();
}
