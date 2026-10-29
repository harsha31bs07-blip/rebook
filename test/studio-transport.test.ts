import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { studioModelCompletion } from "../lib/ai/studio-transport";
import { providerMessages } from "../lib/ai/studio-request";
import { providerBody, RecoveryHarnessSchema } from "../lib/insights/llm";
import { seedStudio } from "../lib/seed/seed";
import { limits } from "../lib/api/limits";

let epoch = Math.floor(Date.now() / 1000) * 1000;
let fetchMock: ReturnType<typeof vi.fn>;
let log: ReturnType<typeof vi.spyOn>;
const complete = (content = "small") => studioModelCompletion(undefined, undefined, undefined,
  ({ model }) => ({ model, stream: false, messages: [{ role: "user", content }] }), (value) => value);
const sent = () => fetchMock.mock.calls.map(([url, options]) => ({ provider: new URL(url).hostname.startsWith("api.groq") ? "groq" : "gemini", model: JSON.parse(options.body).model }));

beforeEach(() => {
  limits.reset();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch += 120_000);
  vi.stubEnv("AI_MODELS", undefined); vi.stubEnv("GEMINI_MODELS", undefined);
  vi.stubEnv("GEMINI_API_KEY", "gemini-secret"); vi.stubEnv("GROQ_API_KEY", "groq-secret");
  vi.stubEnv("GROQ_MAX_INPUT_TOKENS", undefined);
  fetchMock = vi.fn().mockImplementation(async () => new Response("private upstream body", { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  log = vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("provider chain", () => {
  it("uses the interleaved default order and logs only safe fields", async () => {
    await expect(complete("private prompt")).rejects.toMatchObject({ status: 503 });
    expect(sent()).toEqual([
      { provider: "gemini", model: "gemini-3.5-flash-lite" },
      { provider: "groq", model: "openai/gpt-oss-120b" },
      { provider: "gemini", model: "gemini-3.5-flash" },
      { provider: "groq", model: "openai/gpt-oss-20b" },
      { provider: "groq", model: "qwen/qwen3.8-27b" },
      { provider: "gemini", model: "gemini-3.1-flash-lite" },
    ]);
    for (const [entry] of log.mock.calls) {
      expect(Object.keys(JSON.parse(entry)).sort()).toEqual(["message", "model", "ms", "provider", "status"]);
      expect(JSON.parse(entry)).toMatchObject({ message: "ai_call", status: 500, ms: 0 });
      expect(entry).not.toMatch(/secret|private/);
    }
  });
  it.each(["gemini", "groq", "both"])("skips entries without %s credentials", async (missing) => {
    if (missing !== "groq") vi.stubEnv("GEMINI_API_KEY", "  ");
    if (missing !== "gemini") vi.stubEnv("GROQ_API_KEY", "");
    await expect(complete()).rejects.toMatchObject({ status: 503 });
    expect(sent().map(({ provider }) => provider)).toEqual(missing === "both" ? [] : missing === "gemini" ? ["groq", "groq", "groq"] : ["gemini", "gemini", "gemini"]);
  });
  it("keeps GEMINI_MODELS compatibility and lets AI_MODELS override it", async () => {
    vi.stubEnv("GEMINI_MODELS", " old-a,old-b,old-a ");
    await expect(complete()).rejects.toMatchObject({ status: 503 });
    expect(sent()).toEqual([{ provider: "gemini", model: "old-a" }, { provider: "gemini", model: "old-b" }]);
    fetchMock.mockClear();
    vi.stubEnv("AI_MODELS", "groq:new,gemini:new,groq:last");
    await expect(complete()).rejects.toMatchObject({ status: 503 });
    expect(sent()).toEqual([{ provider: "groq", model: "new" }, { provider: "gemini", model: "new" }, { provider: "groq", model: "last" }]);
  });
  it("continues to the other provider after an authentication failure", async () => {
    vi.stubEnv("AI_MODELS", "gemini:first,gemini:second,groq:last");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(Response.json({ ok: true }));
    expect(await complete()).toEqual({ ok: true });
    expect(sent()).toEqual([{ provider: "gemini", model: "first" }, { provider: "groq", model: "last" }]);
  });
  it("scopes cooldowns to provider:model", async () => {
    vi.stubEnv("AI_MODELS", "gemini:same,groq:same");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 })).mockImplementation(async () => Response.json({ ok: true }));
    await complete(); await complete();
    expect(sent()).toEqual([{ provider: "gemini", model: "same" }, { provider: "groq", model: "same" }, { provider: "groq", model: "same" }]);
  });
  it.each([
    ["45", 45_000], ["999", 60_000], ["invalid", 30_000], ["-5", 30_000], [null, 30_000], ["date", 45_000],
  ])("honours Groq 429 Retry-After %s with a 60 second cap", async (retry, delay) => {
    vi.stubEnv("AI_MODELS", "groq:limited");
    const header = retry === "date" ? new Date(Date.now() + 45_000).toUTCString() : retry;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429, headers: header === null ? {} : { "Retry-After": header } })).mockImplementation(async () => Response.json({ ok: true }));
    await expect(complete()).rejects.toMatchObject({ status: 503 });
    vi.setSystemTime(Date.now() + delay - 1);
    await expect(complete()).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    expect(await complete()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("skips a Groq 413 without cooling down the model", async () => {
    vi.stubEnv("AI_MODELS", "groq:small,gemini:fallback");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 413 })).mockImplementation(async () => Response.json({ ok: true }));
    await complete(); await complete();
    expect(sent().map(({ model }) => model)).toEqual(["small", "fallback", "small"]);
    expect(log.mock.calls.map(([entry]: [string]) => JSON.parse(entry).status)).toEqual(["too_large", 200, 200]);
  });
  it("uses UTF-8 bytes for the input gate, including configurable boundaries", async () => {
    vi.stubEnv("AI_MODELS", "groq:sized");
    const content = "\u00e9".repeat(100);
    const size = Math.ceil(Buffer.byteLength(JSON.stringify({ model: "sized", stream: false, messages: [{ role: "user", content }] })) / 8);
    vi.stubEnv("GROQ_MAX_INPUT_TOKENS", String(size - 1));
    await expect(complete(content)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("GROQ_MAX_INPUT_TOKENS", String(size));
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    expect(await complete(content)).toEqual({ ok: true });
  });
  it("strips message and call metadata for Groq without changing Gemini signatures or input", () => {
    const messages = [{ role: "assistant", content: null, extra_content: { google: { private: true } }, tool_calls: [
      { id: "signed", extra_content: { google: { thought_signature: "exact" } } }, { id: "injected" },
    ] }];
    expect(JSON.stringify(providerMessages(messages, "groq"))).not.toContain("extra_content");
    expect(providerMessages(messages, "gemini")[0].tool_calls).toMatchObject([
      { extra_content: { google: { thought_signature: "exact" } } }, { extra_content: { google: { thought_signature: "skip_thought_signature_validator" } } },
    ]);
    expect(messages[0].tool_calls[1]).toEqual({ id: "injected" });
  });
  it.each(["required", { name: "get_disruptions" }] as const)("preserves harness tool choice %s and JSON schema on Groq", async (toolChoice) => {
    const request = RecoveryHarnessSchema.parse({ messages: [{ role: "user", content: "Read" }], harness: {
      agent: "recovery-analyst", instructions: "Read only", tools: [{ name: "get_disruptions", description: "Read", parameters: { type: "object" } }], toolChoice,
      responseFormat: { type: "json", name: "summary", schema: { type: "object", properties: { text: { type: "string" } } } },
    } });
    vi.stubEnv("AI_MODELS", "groq:harness");
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    await studioModelCompletion(undefined, undefined, undefined, (target) => providerBody(request, seedStudio(), target), (value) => value);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tool_choice).toEqual(typeof toolChoice === "string" ? "required" : { type: "function", function: { name: toolChoice.name } });
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "summary", schema: request.harness.responseFormat?.type === "json" ? request.harness.responseFormat.schema : {} } });
    expect(body).toMatchObject({ stream: false, max_tokens: 4096 });
    expect(body.tools[0]).toEqual({ type: "function", function: request.harness.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))[0] });
  });
});

describe("busy retry hint", () => {
  it("tells the browser when every model is briefly rate-limited", async () => {
    vi.stubEnv("AI_MODELS", "gemini:a,groq:b");
    fetchMock.mockImplementation(async (url: string) => new Response(null, { status: 429, headers: url.includes("groq") ? { "retry-after": "4" } : {} }));
    await expect(complete()).rejects.toMatchObject({ status: 503, retryAfter: 4 });
  });
  it("gives no hint when a model fails in a way a short wait will not fix", async () => {
    vi.stubEnv("AI_MODELS", "gemini:a,groq:b");
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 500 }))
      .mockImplementationOnce(async () => new Response(null, { status: 429, headers: { "retry-after": "4" } }));
    await expect(complete()).rejects.toMatchObject({ status: 503, retryAfter: undefined });
  });
  it("ignores Groq entries skipped for size when deciding the hint", async () => {
    vi.stubEnv("AI_MODELS", "gemini:a,groq:b"); vi.stubEnv("GROQ_MAX_INPUT_TOKENS", "1");
    fetchMock.mockImplementation(async () => new Response(null, { status: 429 }));
    await expect(complete("a longer prompt")).rejects.toMatchObject({ status: 503 });
    expect(sent()).toEqual([{ provider: "gemini", model: "a" }]);
  });
});
