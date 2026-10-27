import { StoreError } from "../store";
import { limits } from "../api/limits";
import type { AiIdentity } from "./gemini";

const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 30_000;
export type AiProvider = "gemini" | "groq";
export type AiModel = { provider: AiProvider; model: string };
// Measured on real Studio turns: 28 KB = 1,803 Groq tokens, 51 KB = 6,205 (about 8 bytes per token).
const GROQ_BYTES_PER_TOKEN = 8;
const DEFAULT_MODELS = "gemini:gemini-flash-lite-latest,groq:openai/gpt-oss-120b,gemini:gemini-3.5-flash,groq:openai/gpt-oss-20b,groq:qwen/qwen3.8-27b,gemini:gemini-flash-latest";
const endpoints = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
};

function configuredModels(): AiModel[] {
  const configured = process.env.AI_MODELS ?? (process.env.GEMINI_MODELS !== undefined
    ? process.env.GEMINI_MODELS.split(",").map((model) => `gemini:${model.trim()}`).join(",") : DEFAULT_MODELS);
  return [...new Set(configured.split(",").map((entry) => entry.trim()))].flatMap((entry) => {
    const separator = entry.indexOf(":");
    const provider = entry.slice(0, separator).trim(), model = entry.slice(separator + 1).trim();
    return separator > 0 && (provider === "gemini" || provider === "groq") && model ? [{ provider, model }] : [];
  });
}

function retryAfterMs(value: string | null): number {
  if (!value?.trim()) return COOLDOWN_MS;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : COOLDOWN_MS;
}

// Keep validation in the callers: only repair absent call IDs and discard provider metadata.
function normalizeGroq(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("choices" in value) || !Array.isArray(value.choices)) return value;
  return { ...value, choices: value.choices.map((choice: unknown) => {
    if (!choice || typeof choice !== "object" || !("message" in choice)) return choice;
    const message = choice.message;
    if (!message || typeof message !== "object" || !("tool_calls" in message) || !Array.isArray(message.tool_calls)) return choice;
    return { ...choice, message: { ...message, tool_calls: message.tool_calls.map((call: unknown) => {
      if (!call || typeof call !== "object") return call;
      const entry = call as Record<string, unknown>;
      return { id: entry.id === undefined || entry.id === null || entry.id === "" ? `call_${crypto.randomUUID()}` : entry.id,
        type: entry.type ?? "function", function: entry.function };
    }) } };
  }) };
}
export const analystUnavailable = () => new StoreError(503, "The analyst is busy right now — try again in a moment.");

/** Shared by legacy chat and every Studio agent. Quotas still count each upstream attempt. */
export async function studioModelCompletion<T>(
  preferred: string | undefined, signal: AbortSignal | undefined, identity: AiIdentity | undefined,
  body: (target: AiModel) => unknown, validate: (value: unknown, target: AiModel) => T,
  options: { models?: AiModel[]; timeoutMs?: number; budgetMs?: number } = {},
): Promise<T> {
  const keys = { gemini: process.env.GEMINI_API_KEY?.trim(), groq: process.env.GROQ_API_KEY?.trim() };
  const configured = (options.models ?? configuredModels()).filter(({ provider }) => keys[provider]);
  const selected = configured.find(({ provider, model }) => preferred === model || preferred === `${provider}:${model}`);
  const models = selected ? [selected, ...configured.filter((target) => target !== selected)] : configured;
  const unavailable = new Set<AiProvider>();
  const started = Date.now();
  const budget = Math.min(options.budgetMs ?? 35_000, 35_000);
  for (const [index, target] of models.entries()) {
    const { provider, model } = target;
    const cooldownKey = `${provider}:${model}`;
    if (signal?.aborted || Date.now() - started >= budget) break;
    if (unavailable.has(provider)) continue;
    if ((cooldowns.get(cooldownKey) ?? 0) > Date.now()) {
      console.info(JSON.stringify({ message: "ai_call", provider, model, status: "cooldown", ms: 0 }));
      continue;
    }
    cooldowns.delete(cooldownKey);
    const serialized = JSON.stringify(body(target));
    const configuredMax = Number(process.env.GROQ_MAX_INPUT_TOKENS ?? 7000);
    const maxInput = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 7000;
    if (provider === "groq" && Math.ceil(new TextEncoder().encode(serialized).byteLength / GROQ_BYTES_PER_TOKEN) > maxInput) {
      console.info(JSON.stringify({ message: "ai_call", provider, model, status: "too_large", ms: 0 }));
      continue;
    }
    let release: () => void;
    try {
      release = limits.aiCall(identity?.client ?? "unknown", identity?.workspace ?? "unknown");
    } catch (error) {
      console.info(JSON.stringify({ message: "ai_call", provider, model, status: "local_limit", ms: 0 }));
      throw error;
    }
    const controller = new AbortController();
    const attemptStarted = Date.now();
    let status: number | string = "network_error";
    let cooldownMs = COOLDOWN_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          status = "timeout";
          controller.abort();
          reject(analystUnavailable());
        }, Math.min(options.timeoutMs ?? (index === 0 ? 10_000 : 20_000), budget - (Date.now() - started)));
        onAbort = () => { status = "cancelled"; controller.abort(); reject(analystUnavailable()); };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      const result = await Promise.race([(async () => {
        const response = await fetch(endpoints[provider], {
          method: "POST", cache: "no-store", signal: controller.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${keys[provider]}` },
          body: serialized,
        });
        if (response.status === 429) cooldownMs = retryAfterMs(response.headers.get("retry-after"));
        if (!response.ok) return { status: response.status };
        const value: unknown = await response.json();
        return { status: response.status, completion: validate(provider === "groq" ? normalizeGroq(value) : value, target) };
      })(), deadline]);
      status = provider === "groq" && result.status === 413 ? "too_large" : result.status;
      if (result.completion !== undefined) return result.completion;
      if (status === 401 || status === 403) unavailable.add(provider);
    } catch {
      if (status === "network_error") status = "invalid_response_or_transport";
      // Do not log bodies, request URLs, credentials, or upstream error text.
    } finally {
      if (status === 429 || status === 503 || status === "timeout") cooldowns.set(cooldownKey, Date.now() + cooldownMs);
      console.info(JSON.stringify({ message: "ai_call", provider, model, status, ms: Date.now() - attemptStarted }));
      release();
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }
  throw analystUnavailable();
}
