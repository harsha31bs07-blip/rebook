import { StoreError } from "../store";
import { limits } from "../api/limits";
import type { AiIdentity } from "./gemini";

const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 30_000;
export const analystUnavailable = () => new StoreError(503, "The analyst is busy right now — try again in a moment.");

/** Shared by legacy chat and every Studio agent. Quotas still count each upstream attempt. */
export async function studioModelCompletion<T>(
  preferred: string | undefined, signal: AbortSignal | undefined, identity: AiIdentity | undefined,
  body: (model: string) => unknown, validate: (value: unknown) => T,
): Promise<T> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw analystUnavailable();
  const configured = [...new Set((process.env.GEMINI_MODELS || "gemini-flash-lite-latest,gemini-3.5-flash,gemini-flash-latest").split(",").map((model) => model.trim()).filter(Boolean))];
  const models = preferred && configured.includes(preferred) ? [preferred, ...configured.filter((model) => model !== preferred)] : configured;
  const started = Date.now();
  for (const [index, model] of models.entries()) {
    if (signal?.aborted || Date.now() - started >= 25_000) break;
    if ((cooldowns.get(model) ?? 0) > Date.now()) {
      console.info(JSON.stringify({ message: "ai_call", model, status: "cooldown", ms: 0 }));
      continue;
    }
    cooldowns.delete(model);
    const release = limits.aiCall(identity?.client ?? "unknown", identity?.workspace ?? "unknown");
    const controller = new AbortController();
    const attemptStarted = Date.now();
    let status: number | string = "network_error";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          status = "timeout";
          controller.abort();
          reject(analystUnavailable());
        }, Math.min(index === 0 ? 4_000 : 20_000, 25_000 - (Date.now() - started)));
        onAbort = () => { status = "cancelled"; controller.abort(); reject(analystUnavailable()); };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      const result = await Promise.race([(async () => {
        const response = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
          method: "POST", cache: "no-store", signal: controller.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify(body(model)),
        });
        if (!response.ok) return { status: response.status };
        return { status: response.status, completion: validate(await response.json()) };
      })(), deadline]);
      status = result.status;
      if (result.completion !== undefined) return result.completion;
      if (status === 401 || status === 403) break;
    } catch {
      if (status === "network_error") status = "invalid_response_or_transport";
      // Do not log bodies, request URLs, credentials, or upstream error text.
    } finally {
      if (status === 429 || status === 503 || status === "timeout") cooldowns.set(model, Date.now() + COOLDOWN_MS);
      console.info(JSON.stringify({ message: "ai_call", model, status, ms: Date.now() - attemptStarted }));
      release();
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }
  throw analystUnavailable();
}
