import { z } from "zod";
import { studioModelCompletion, type AiProvider } from "./studio-transport";
export type AiIdentity = { client: string; workspace: string };

export class AiUnavailable extends Error {
  constructor(public busy = false) {
    super("AI interpretation is unavailable; please use the local rules.");
    this.name = "AiUnavailable";
  }
}

export type GenerateOptions = {
  models?: string[];
  timeoutMs?: number;
  budgetMs?: number;
  systemInstruction?: string;
  identity?: AiIdentity;
};

const EnvelopeSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

// Existing callers use Gemini's uppercase types/nullable flag; Chat Completions takes JSON Schema.
function jsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "nullable").map(([key, value]) => {
    if (key === "type" && typeof value === "string") return [key, value.toLowerCase()];
    if (key === "properties" && value && typeof value === "object") return [key, Object.fromEntries(Object.entries(value).map(([name, field]) => [name, jsonSchema(field as Record<string, unknown>)]))];
    if (key === "items" && value && typeof value === "object") return [key, jsonSchema(value as Record<string, unknown>)];
    return [key, value];
  }));
  if (schema.nullable) {
    result.type = [result.type, "null"];
    if (Array.isArray(result.enum)) result.enum = [...result.enum, null];
  }
  return result;
}

/** Shared provider deadlines cover fetching and reading the body, even if fetch ignores abort. */
export async function generateJson<T>(
  prompt: string, schema: Record<string, unknown>, zodSchema: z.ZodType<T>, opts: GenerateOptions = {},
): Promise<{ data: T; provider: AiProvider; model: string; latencyMs: number }> {
  const started = Date.now();
  try {
    return await studioModelCompletion(undefined, undefined, opts.identity,
      ({ model }) => ({
        model, stream: false, max_tokens: 4096,
        messages: [...(opts.systemInstruction ? [{ role: "system", content: opts.systemInstruction }] : []), { role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: { name: "rebook_response", schema: jsonSchema(schema) } },
      }),
      (value, { provider, model }) => ({ data: zodSchema.parse(JSON.parse(EnvelopeSchema.parse(value).choices[0].message.content)), provider, model, latencyMs: Date.now() - started }),
      { models: opts.models?.map((model) => ({ provider: "gemini", model })), timeoutMs: opts.timeoutMs, budgetMs: opts.budgetMs });
  } catch {
    // The interpreter retains its deterministic rules fallback, including local quota rejection.
    throw new AiUnavailable(true);
  }
}
