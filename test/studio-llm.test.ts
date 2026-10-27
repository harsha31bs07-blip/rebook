import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/workspaces/[id]/llm/route";
import { studioCompletion } from "../lib/ai/studio-gemini";
import { closeRepository, getRepository } from "../lib/store";
import { seedStudio } from "../lib/seed/seed";
import { limits } from "../lib/api/limits";
import { delegatedTurn } from "./fixtures/delegated-turn";
import { STUDIO_REQUEST_BYTES } from "../lib/ai/studio-request";
import { directLlmRunner, type AgAiEvent } from "ag-studio";
import { ANALYST_UNAVAILABLE, geminiAdapter } from "../lib/insights/gemini-adapter";
import { recoveryRunGuard } from "../lib/insights/run-guard";

let directory: string;
let epoch = Date.now();
beforeEach(() => {
  limits.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(epoch += 120_000);
  directory = mkdtempSync(join(tmpdir(), "rebook-studio-llm-"));
  vi.stubEnv("DATA_DIR", directory); vi.stubEnv("GEMINI_API_KEY", "test-secret");
  vi.stubEnv("GEMINI_MODELS", "gemini-flash-lite-latest,gemini-3.5-flash");
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const body = { messages: [{ role: "user" as const, content: "What did Monday cost?" }] };
const completion = { id: "ok", choices: [{ message: { role: "assistant", content: "Read the recovery records." }, finish_reason: "stop" }] };
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (value: unknown = body) => new Request("http://localhost/llm", { method: "POST", body: JSON.stringify(value) });

describe("Studio LLM proxy", () => {
  it("accepts live built-in agent tools and the completion tool injected into delegated runs", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: "configured", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "done", type: "function", function: { name: "complete_task", arguments: '{"summary":"Applied Maya filter","artifacts":[]}' } }] } }] }));
    vi.stubGlobal("fetch", fetch);
    const workspace = getRepository().createWorkspace(seedStudio());
    const tools = ["view_schema", "view_page", "view_plan", "add_widget", "position_widget", "remove_widget", "add_page_filter", "remove_page_filter", "complete_task"].map((name) => ({ name, description: "Studio tool", kind: "client", parameters: { type: "object", properties: { field: { const: "sessions.instructor" } } } }));
    const response = await POST(new Request("http://localhost/llm", { method: "POST", headers: { "X-Rebook-Studio": "harness" }, body: JSON.stringify({ ...body, model: "unapproved", harness: { agent: "page", instructions: "Apply the exact instructor filter with add_page_filter.", tools, toolChoice: { name: "complete_task" } } }) }), context(workspace.id));
    expect(response.status).toBe(200);
    const provider = JSON.parse(fetch.mock.calls[0][1].body);
    expect(provider.messages[0].role).toBe("system");
    expect(provider.messages[0].content).toContain(workspace.state.studio.name);
    expect(provider.messages[1]).toEqual({ role: "system", content: "Apply the exact instructor filter with add_page_filter." });
    expect(provider.tools.map((entry: { function: unknown }) => entry.function)).toEqual(tools.map(({ name, description, parameters }) => ({ name, description, parameters })));
    expect(provider.tool_choice).toEqual({ type: "function", function: { name: "complete_task" } });
    expect(provider.model).toBe("gemini-flash-lite-latest");
    expect(provider.max_tokens).toBe(4096);
    expect((await response.json()).choices[0].message.tool_calls[0].function.name).toBe("complete_task");
  });
  it("accepts realistic 50 KiB delegated turns and three concurrent calls after prior fallback rounds", async () => {
    const workspace = getRepository().createWorkspace(seedStudio());
    const payload = delegatedTurn();
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    expect(bytes).toBeGreaterThanOrEqual(50_000);
    expect(bytes).toBeLessThan(65_536);
    console.info(JSON.stringify({ message: "delegated_test_payload", bytes }));
    // Three previous two-model rounds have already consumed six upstream attempts.
    for (let i = 0; i < 6; i++) limits.aiCall("unknown", workspace.id)();
    const signals: AbortSignal[] = [];
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const fetch = vi.fn().mockImplementation(async (_url, options) => {
      signals.push(options.signal);
      await held;
      return Response.json(completion);
    });
    vi.stubGlobal("fetch", fetch);
    const pending = Array.from({ length: 3 }, () => POST(new Request("http://localhost/llm", { method: "POST", headers: { "X-Rebook-Studio": "harness" }, body: JSON.stringify(payload) }), context(workspace.id)));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    finish();
    expect((await Promise.all(pending)).map((response) => response.status)).toEqual([200, 200, 200]);
    const provider = JSON.parse(fetch.mock.calls[0][1].body);
    expect(provider.messages[3].tool_calls[0].extra_content.google.thought_signature).toBe("delegate-signature-exact==");
    expect(provider.tools[0].function.parameters).toEqual(payload.harness.tools[0].parameters);
  });
  it("accepts a large legacy conversation and rejects both contracts above the byte ceiling", async () => {
    const workspace = getRepository().createWorkspace(seedStudio());
    const fetch = vi.fn().mockResolvedValue(Response.json(completion)); vi.stubGlobal("fetch", fetch);
    expect((await POST(post({ messages: [{ role: "user", content: "x".repeat(50_000) }] }), context(workspace.id))).status).toBe(200);
    for (const harness of [false, true]) {
      const payload = harness ? delegatedTurn() : { messages: [{ role: "user", content: "" }] };
      payload.messages[0].content = "\u00e9".repeat(STUDIO_REQUEST_BYTES / 2);
      const response = await POST(new Request("http://localhost/llm", { method: "POST", headers: harness ? { "X-Rebook-Studio": "harness" } : {}, body: JSON.stringify(payload) }), context(workspace.id));
      expect(response.status).toBe(413);
      expect((await response.json()).error).toContain("too large");
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects tools from another agent or external providers before making a harness request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const workspace = getRepository().createWorkspace(seedStudio());
    const harness = { agent: "page", instructions: "Filter", tools: [{ name: "add_page_filter", description: "Filter", parameters: { type: "object" } }] };
    for (const invalid of [
      { ...harness, tools: [{ ...harness.tools[0], name: "configure_widget" }] },
      { ...harness, tools: [{ ...harness.tools[0], name: "fetch_url" }] },
      { ...harness, tools: [{ ...harness.tools[0], kind: "provided" }] },
      { ...harness, toolChoice: { name: "remove_widget" } },
    ]) {
      const response = await POST(new Request("http://localhost/llm", { method: "POST", headers: { "X-Rebook-Studio": "harness" }, body: JSON.stringify({ ...body, harness: invalid }) }), context(workspace.id));
      expect(response.status).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("falls back models on errors, caps output, keeps signatures and uses only Chat Completions", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("retired", { status: 404 })).mockResolvedValueOnce(Response.json(completion));
    vi.stubGlobal("fetch", fetch);
    const workspace = getRepository().createWorkspace(seedStudio());
    const call = { id: "tc1", type: "function", function: { name: "get_disruptions", arguments: "{}" }, extra_content: { google: { thought_signature: "opaque-exact" } } };
    const response = await POST(post({ model: "unapproved-model", messages: [body.messages[0], { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: "tc1", content: "[]" }] }), context(workspace.id));
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    const first = JSON.parse(fetch.mock.calls[0][1].body), second = JSON.parse(fetch.mock.calls[1][1].body);
    expect(first.model).toBe("gemini-flash-lite-latest"); expect(second.model).toBe("gemini-3.5-flash");
    expect(second.messages[2].tool_calls[0]).toEqual(call);
    expect(second.messages[0].role).toBe("system");
    expect(second.tools.some((tool: { function: { name: string } }) => tool.function.name === "get_disruptions")).toBe(true);
    expect(second.max_tokens).toBe(4096); expect(second.stream).toBe(false);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer test-secret");
    expect(await response.text()).not.toContain("test-secret");
  });
  it("limits each workspace and client and reopens the bucket after a minute", async () => {
    vi.stubEnv("AI_CLIENT_CALLS_PER_MIN", "10");
    vi.stubEnv("AI_WORKSPACE_CALLS_PER_MIN", "10");
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json(completion)));
    vi.stubGlobal("fetch", fetch);
    const workspace = getRepository().createWorkspace(seedStudio());
    for (let index = 0; index < 10; index++) expect((await POST(post(), context(workspace.id))).status).toBe(200);
    expect((await POST(post(), context(workspace.id))).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(10);
    const other = getRepository().createWorkspace(seedStudio());
    expect((await POST(post(), context(other.id))).status).toBe(503);
    vi.setSystemTime(Date.now() + 60_001);
    expect((await POST(post(), context(workspace.id))).status).toBe(200);
  });
  it("returns friendly 503 for missing key/all models failing and never exposes upstream secrets", async () => {
    const workspace = getRepository().createWorkspace(seedStudio());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream-secret", { status: 500 })));
    const response = await POST(post(), context(workspace.id));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/test-secret|upstream-secret/);
    vi.stubEnv("GEMINI_API_KEY", "");
    expect((await POST(post(), context(workspace.id))).status).toBe(503);
  });
  it("carries all-model 503 failures through the route and adapter to Studio's terminal chat error", async () => {
    const workspace = getRepository().createWorkspace(seedStudio());
    const fetch = vi.fn().mockImplementation((url, options) => url === "/llm"
      ? POST(new Request("http://localhost/llm", options), context(workspace.id))
      : Promise.resolve(new Response("upstream-secret", { status: 503 })));
    vi.stubGlobal("fetch", fetch);
    const runner = recoveryRunGuard()(directLlmRunner({ id: "page", adapter: geminiAdapter("/llm", "page") }));
    const events: AgAiEvent[] = [];
    for await (const event of runner.run({ threadId: "thread", runId: "run", messages: [{ id: "user", role: "user", content: "Add the chart" }], tools: [], state: {}, context: [], forwardedProps: {} }, { params: {}, instructions: () => "Add the chart", tools: () => [] })) events.push(event);
    expect(fetch).toHaveBeenCalledTimes(3); // One local request, two upstream models.
    expect(events.at(-1)).toMatchObject({ type: "RUN_ERROR", message: ANALYST_UNAVAILABLE });
    expect(JSON.stringify(events)).not.toContain("upstream-secret");
  });
  it("applies deadlines to transports that ignore abort and falls back", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(Response.json(completion));
    vi.stubGlobal("fetch", fetch);
    const pending = studioCompletion(body);
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await pending).id).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it.each([429, 503])("skips recently overloaded models (%s) across agents and retries them after cooldown", async (status) => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status })).mockImplementation(() => Promise.resolve(Response.json(completion)));
    vi.stubGlobal("fetch", fetch);
    const workspace = getRepository().createWorkspace(seedStudio());
    expect((await POST(post(), context(workspace.id))).status).toBe(200);
    expect((await POST(new Request("http://localhost/llm", { method: "POST", headers: { "X-Rebook-Studio": "harness" }, body: JSON.stringify(delegatedTurn()) }), context(workspace.id))).status).toBe(200);
    expect(fetch.mock.calls.map((entry) => JSON.parse(entry[1].body).model)).toEqual(["gemini-flash-lite-latest", "gemini-3.5-flash", "gemini-3.5-flash"]);
    vi.setSystemTime(Date.now() + 30_001);
    expect((await POST(post(), context(workspace.id))).status).toBe(200);
    expect(JSON.parse(fetch.mock.calls[3][1].body).model).toBe("gemini-flash-lite-latest");
  });
  it("bounds the full model chain, aborts hung bodies and logs only model/status/timing", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GEMINI_MODELS", "slow-a,slow-b,slow-c,slow-d");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetch = vi.fn().mockImplementation(() => Promise.resolve({ ok: true, json: () => new Promise(() => {}) }));
    vi.stubGlobal("fetch", fetch);
    const pending = studioCompletion(body);
    const rejected = expect(pending).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(35_000);
    await rejected;
    expect(fetch.mock.calls.map((entry) => JSON.parse(entry[1].body).model)).toEqual(["slow-a", "slow-b", "slow-c"]);
    expect(fetch.mock.calls.every((entry) => entry[1].signal.aborted)).toBe(true);
    expect(log.mock.calls.map(([entry]) => JSON.parse(entry))).toEqual([
      { message: "ai_call", model: "slow-a", status: "timeout", ms: 10000 },
      { message: "ai_call", model: "slow-b", status: "timeout", ms: 20000 },
      { message: "ai_call", model: "slow-c", status: "timeout", ms: 5000 },
    ]);
    log.mockRestore();
  });
  it("checks workspace and request shape before making an upstream call", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await POST(post(), context("missing123"))).status).toBe(404);
    const workspace = getRepository().createWorkspace(seedStudio());
    expect((await POST(post({ messages: [] }), context(workspace.id))).status).toBe(400);
    expect((await POST(new Request("http://localhost", { method: "POST", body: "{" }), context(workspace.id))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
