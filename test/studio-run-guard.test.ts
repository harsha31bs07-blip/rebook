import { afterEach, describe, expect, it, vi } from "vitest";
import { directLlmRunner, type AgAiEvent, type AgAiTool, type AgAiRunInput } from "ag-studio";
import { geminiAdapter, ANALYST_UNAVAILABLE } from "../lib/insights/gemini-adapter";
import { ANALYST_RUN_TIMEOUT_MS, recoveryRunGuard } from "../lib/insights/run-guard";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const input: AgAiRunInput = { threadId: "thread", runId: "parent", messages: [{ id: "user", role: "user", content: "Add a bar chart of revenue by class type to this page" }], tools: [], state: {}, context: [], forwardedProps: {} };
const context = { params: {}, instructions: () => "Edit the report", tools: () => [] };
const collect = async (events: AsyncIterable<AgAiEvent>) => { const result = []; for await (const event of events) result.push(event); return result; };

describe("Recovery chat run guard", () => {
  it("turns proxy outages into the terminal error event consumed by Studio chat", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const guard = recoveryRunGuard();
    const runner = guard(directLlmRunner({ id: "recovery-analyst", adapter: geminiAdapter("/llm", "recovery-analyst") }));
    const events = await collect(runner.run(input, context));
    expect(events.at(-1)).toMatchObject({ type: "RUN_ERROR", message: ANALYST_UNAVAILABLE });
    expect(events.some((event) => event.type === "RUN_FINISHED")).toBe(false);
  });
  it("propagates a delegated agent error to its parent without another LLM round", async () => {
    const guard = recoveryRunGuard();
    const child = guard(directLlmRunner({ id: "page", adapter: geminiAdapter("/llm", "page") }));
    const childEvents: AgAiEvent[] = [];
    const delegate: AgAiTool = {
      name: "delegate_to", description: "Delegate report changes", kind: "client",
      schema: () => ({ name: "delegate_to", description: "Delegate", parameters: { type: "object" } }),
      execute: async (_call, ctx) => {
        childEvents.push(...await collect(child.run({ ...input, runId: "child", parentRunId: "parent", parentToolCallId: "delegate" }, { ...context, signal: ctx.signal })));
        // AG Studio 3's delegate tool returns this even when its child session failed.
        return { success: true, response: "(the delegate finished without a summary)" };
      },
    };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ id: "delegation", choices: [{ message: { role: "assistant", tool_calls: [{ id: "delegate", type: "function", function: { name: "delegate_to", arguments: "{}" } }] } }] })).mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const parent = guard(directLlmRunner({ id: "recovery-analyst", adapter: geminiAdapter("/llm", "recovery-analyst") }));
    const events = await collect(parent.run(input, { ...context, tools: () => [delegate] }));
    expect(childEvents).toContainEqual({ type: "RUN_ERROR", message: ANALYST_UNAVAILABLE, code: undefined });
    expect(events.at(-1)).toMatchObject({ type: "RUN_ERROR", message: ANALYST_UNAVAILABLE });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === "RUN_FINISHED")).toEqual([]);
  });
  it("ends an overall run at the run deadline and aborts tools that never settle", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const guard = recoveryRunGuard();
    const runner = guard({ id: "recovery-analyst", async *run(_input, ctx) {
      signal = ctx.signal;
      yield { type: "RUN_STARTED", threadId: "thread", runId: "parent" };
      await new Promise(() => {});
    } });
    const pending = collect(runner.run(input, context));
    await vi.advanceTimersByTimeAsync(ANALYST_RUN_TIMEOUT_MS);
    expect((await pending).at(-1)).toEqual({ type: "RUN_ERROR", message: ANALYST_UNAVAILABLE });
    expect(signal?.aborted).toBe(true);
  });
  it("keeps successful and manually cancelled runs distinct from outages", async () => {
    const guard = recoveryRunGuard();
    const controller = new AbortController(); controller.abort();
    const runner = guard(directLlmRunner({ id: "recovery-analyst", adapter: geminiAdapter("/llm") }));
    const cancelled = await collect(runner.run(input, { ...context, signal: controller.signal }));
    expect(cancelled.at(-1)?.type).toBe("RUN_FINISHED");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ id: "answer", choices: [{ message: { role: "assistant", content: "Added the revenue chart." } }] })));
    const success = await collect(runner.run(input, context));
    expect(success.at(-1)?.type).toBe("RUN_FINISHED");
    expect(success.some((event) => event.type === "RUN_ERROR")).toBe(false);
  });
  it("settles manual cancellation immediately even when a tool ignores abort", async () => {
    const controller = new AbortController();
    const runner = recoveryRunGuard()({ id: "recovery-analyst", async *run() {
      yield { type: "RUN_STARTED", threadId: "thread", runId: "parent" };
      await new Promise(() => {});
    } });
    const stream = runner.run(input, { ...context, signal: controller.signal })[Symbol.asyncIterator]();
    expect((await stream.next()).value.type).toBe("RUN_STARTED");
    const next = stream.next();
    controller.abort();
    expect((await next).value).toEqual({ type: "RUN_FINISHED", threadId: "thread", runId: "parent" });
    await stream.next();
  });
});
