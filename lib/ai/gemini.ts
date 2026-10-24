import { z } from "zod";
import { limits } from "../api/limits";
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

const DEFAULT_MODELS = "gemini-flash-lite-latest,gemini-3.5-flash,gemini-flash-latest";
const EnvelopeSchema = z.object({
  candidates: z.array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() })) }) })).min(1),
});

/** The deadline covers fetching and reading the body, including fetch implementations that ignore abort. */
export async function generateJson<T>(
  prompt: string, schema: Record<string, unknown>, zodSchema: z.ZodType<T>, opts: GenerateOptions = {},
): Promise<{ data: T; model: string; latencyMs: number }> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new AiUnavailable();
  const models = opts.models ?? (process.env.GEMINI_MODELS || DEFAULT_MODELS).split(",").map((model) => model.trim()).filter(Boolean);
  const started = Date.now();
  const budget = Math.min(opts.budgetMs ?? 25_000, 25_000);
  for (const model of models) {
    const remaining = budget - (Date.now() - started);
    if (remaining <= 0) break;
    const controller = new AbortController();
    let release: () => void;
    try { release = limits.aiCall(opts.identity?.client ?? "unknown", opts.identity?.workspace ?? "unknown"); }
    catch { throw new AiUnavailable(true); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AiUnavailable());
        }, Math.min(opts.timeoutMs ?? 12_000, 12_000, remaining));
      });
      const result = await Promise.race([
        (async () => {
          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
            {
              method: "POST", signal: controller.signal, cache: "no-store",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                ...(opts.systemInstruction ? { systemInstruction: { parts: [{ text: opts.systemInstruction }] } } : {}),
                generationConfig: { responseMimeType: "application/json", responseSchema: schema },
              }),
            },
          );
          if (!response.ok) {
            // A bad key fails every model; a retired or unknown model (400/404) only fails this one.
            return { ok: false, permanent: response.status === 401 || response.status === 403 } as const;
          }
          const envelope = EnvelopeSchema.parse(await response.json());
          const value = envelope.candidates[0].content.parts.filter((part) => part.text !== undefined).map((part) => part.text).join("");
          return { ok: true, data: zodSchema.parse(JSON.parse(value)) } as const;
        })(),
        timeout,
      ]);
      if (result.ok) return { data: result.data, model, latencyMs: Date.now() - started };
      if (result.permanent) break;
    } catch {
      // Do not expose request URLs, API keys, upstream bodies, or unvalidated model output.
    } finally {
      release();
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  throw new AiUnavailable();
}
