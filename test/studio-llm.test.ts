import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/workspaces/[id]/llm/route";
import { studioCompletion } from "../lib/ai/studio-gemini";
import { closeRepository, getRepository } from "../lib/store";
import { seedStudio } from "../lib/seed/seed";
import { limits } from "../lib/api/limits";

let directory: string;
beforeEach(() => {
  limits.reset();
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
    vi.useFakeTimers({ toFake: ["Date"] });
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
  it("applies deadlines to transports that ignore abort and falls back", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(Response.json(completion));
    vi.stubGlobal("fetch", fetch);
    const pending = studioCompletion(body);
    await vi.advanceTimersByTimeAsync(12_001);
    expect((await pending).id).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
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
