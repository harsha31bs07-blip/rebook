import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgAiConversationItem, AgAiEvent, AgLlmRequest } from "ag-studio";
import { ANALYST_UNAVAILABLE, fromChatCompletion, geminiAdapter, toChatRequest } from "../lib/insights/gemini-adapter";
import type { StudioCompletion } from "../lib/ai/studio-gemini";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const request: AgLlmRequest = { instructions: "Cite tool data.", input: [{ id: "user", kind: "input", type: "message", role: "user", content: [{ type: "text", text: "What did it cost?" }], status: "completed" }],
  tools: [{ name: "get_disruptions", description: "Read plans", parameters: { type: "object", properties: {} } }], toolChoice: { name: "get_disruptions" }, responseFormat: { type: "text" }, model: { id: "gemini-3.5-flash" } };
const toolResponse: StudioCompletion = { id: "answer-1", created: 100, model: "gemini-3.5-flash", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "Checking the ledger.", tool_calls: [
  { id: "call-1", type: "function", function: { name: "get_disruptions", arguments: "{}" }, extra_content: { google: { thought_signature: "opaque+signature/unchanged==" } } },
  { id: "call-2", type: "function", function: { name: "get_refund_receipts", arguments: '{"status":"COMPLETED"}' } },
] } }] };

describe("Studio Gemini adapter", () => {
  it("forwards live Studio delegation schemas and bound widget configuration to the harness proxy", async () => {
    const transport = vi.fn().mockResolvedValue(Response.json({ id: "delegate", choices: [{ message: { role: "assistant", content: "Done." } }] }));
    vi.stubGlobal("fetch", transport);
    const tools = [{ name: "configure_widget", description: "Configure the current chart", kind: "client" as const, parameters: { type: "object", properties: { widgetId: { const: "refund-chart" } } } },
      { name: "complete_task", description: "Finish the delegated task", parameters: { type: "object" } }];
    const handler = geminiAdapter("/llm", "widget").executeTurn({ ...request, instructions: "Configure refund-chart on the money page.", tools, toolChoice: { name: "complete_task" } });
    await handler.complete;
    const options = transport.mock.calls[0][1];
    expect(options.headers["X-Rebook-Studio"]).toBe("harness");
    expect(JSON.parse(options.body).harness).toEqual({ agent: "widget", instructions: "Configure refund-chart on the money page.", tools, toolChoice: { name: "complete_task" }, responseFormat: { type: "text" } });
  });
  it("sends conversation and model only; policy and tools belong to the server", () => {
    const wire = toChatRequest({ ...request, responseFormat: { type: "json", name: "result", schema: { type: "object", properties: {} } } });
    expect(wire.messages).toEqual([{ role: "user", content: "What did it cost?" }]);
    expect(wire).not.toHaveProperty("tools");
    expect(wire).not.toHaveProperty("tool_choice");
    expect(wire.model).toBe("gemini-3.5-flash");
    expect(wire).not.toHaveProperty("response_format");
  });
  it("round-trips parallel calls and Google's exact thought signature on the assistant message", () => {
    const remembered = new Map();
    const { response, events } = fromChatCompletion(toolResponse, remembered);
    expect(events.map((event) => event.type)).toEqual(["TEXT_MESSAGE_CHUNK", "TOOL_CALL_CHUNK", "TOOL_CALL_CHUNK"]);
    expect(response.createdAt).toBe(100_000);
    const next = toChatRequest({ ...request, input: [...request.input, ...response.output,
      { type: "function_call_output", callId: "call-1", output: '{"cost":113}', status: "completed" },
      { type: "function_call_output", callId: "call-2", output: "[]", status: "completed" },
    ] }, remembered);
    expect(next.messages[1]).toEqual({ role: "assistant", content: "Checking the ledger.", tool_calls: toolResponse.choices[0].message.tool_calls });
    expect(next.messages[2]).toEqual({ role: "tool", tool_call_id: "call-1", content: '{"cost":113}' });
    // The extension also survives serializing the output; the sidecar covers hosts which strip it.
    expect(toChatRequest({ ...request, input: JSON.parse(JSON.stringify(response.output)) }).messages[0].tool_calls).toEqual(toolResponse.choices[0].message.tool_calls);
  });
  it("emits protocol chunks, resolves completion, forwards cancellation and preserves signatures across turns", async () => {
    const transport = vi.fn().mockResolvedValueOnce(Response.json(toolResponse)).mockResolvedValueOnce(Response.json({ id: "answer-2", choices: [{ message: { role: "assistant", content: "$113 refunded." }, finish_reason: "stop" }] }));
    vi.stubGlobal("fetch", transport);
    const adapter = geminiAdapter("/api/workspaces/example123/llm");
    const controller = new AbortController();
    const handler = adapter.executeTurn(request, { signal: controller.signal });
    const events: AgAiEvent[] = [];
    for await (const event of handler.stream) events.push(event);
    const first = await handler.complete;
    expect(events).toHaveLength(3);
    expect(transport.mock.calls[0][1].signal.aborted).toBe(false);
    const stripped = first.output.map((item) => item.type === "function_call" ? { id: item.id, kind: item.kind, type: item.type, callId: item.callId, name: item.name, arguments: item.arguments } : item);
    const next = adapter.executeTurn({ ...request, input: [...request.input, ...stripped] });
    for await (const event of next.stream) expect(event.type).toBe("TEXT_MESSAGE_CHUNK");
    expect((await next.complete).status).toBe("completed");
    const body = JSON.parse(transport.mock.calls[1][1].body);
    expect(body.messages[1].tool_calls[0].extra_content).toEqual({ google: { thought_signature: "opaque+signature/unchanged==" } });
  });
  it("regroups Studio's interleaved call/result pairs while retaining separate tool-only turns", () => {
    const remembered = new Map();
    const first = fromChatCompletion({ ...toolResponse, choices: [{ ...toolResponse.choices[0], message: { ...toolResponse.choices[0].message, content: null } }] }, remembered).response;
    const second = fromChatCompletion({ id: "answer-2", choices: [{ message: { role: "assistant", tool_calls: [{ id: "call-3", type: "function", function: { name: "get_disruptions", arguments: "{}" } }] } }] }, remembered).response;
    const input = [...first.output, ...second.output].flatMap<AgAiConversationItem>((item) => item.type === "function_call" ? [item, { type: "function_call_output", callId: item.callId, output: "[]", status: "completed" }] : [item]);
    const wire = toChatRequest({ ...request, input }, remembered);
    expect(wire.messages.map((message) => message.role)).toEqual(["assistant", "tool", "tool", "assistant", "tool"]);
    expect(wire.messages[0].tool_calls).toEqual(toolResponse.choices[0].message.tool_calls);
    expect(wire.messages[3].tool_calls?.[0].id).toBe("call-3");
  });
  it.each([503, 429, 500])("rejects outages (%s) on both channels for top-level and delegated agents", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "upstream-secret" }, { status })));
    for (const agent of [undefined, "page", "widget", "data", "planning"] as const) {
      const handler = geminiAdapter("/llm", agent).executeTurn(request);
      await expect(handler.complete).rejects.toThrow(ANALYST_UNAVAILABLE);
      await expect(handler.stream[Symbol.asyncIterator]().next()).rejects.toThrow(ANALYST_UNAVAILABLE);
    }
    expect(fromChatCompletion({ ...toolResponse, choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: "length" }] }, new Map()).response.status).toBe("incomplete");
  });
  it.each([400, 413])("surfaces readable oversized input errors (%s)", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Invalid input", issues: [{ message: "This conversation is too large. Please start a new conversation." }] }, { status })));
    await expect(geminiAdapter("/llm", "page").executeTurn(request).complete).rejects.toThrow("This conversation is too large");
  });
  it("rejects transport errors without exposing details and honours cancellation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed: upstream stack")));
    await expect(geminiAdapter("/llm").executeTurn(request).complete).rejects.toThrow(ANALYST_UNAVAILABLE);
    const controller = new AbortController(); controller.abort();
    await expect(geminiAdapter("/llm").executeTurn(request, { signal: controller.signal }).complete).rejects.toMatchObject({ name: "AbortError" });
  });
  it("aborts and rejects at 45 seconds even when fetch or the response body ignores abort", async () => {
    vi.useFakeTimers();
    for (const response of [undefined, { ok: true, json: () => new Promise(() => {}) }]) {
      const transport = vi.fn().mockImplementation(() => response ? Promise.resolve(response) : new Promise(() => {}));
      vi.stubGlobal("fetch", transport);
      const handler = geminiAdapter("/llm", "page").executeTurn(request);
      const rejected = expect(handler.complete).rejects.toThrow(ANALYST_UNAVAILABLE);
      await vi.advanceTimersByTimeAsync(45_000);
      await rejected;
      expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
      await expect(handler.stream[Symbol.asyncIterator]().next()).rejects.toThrow(ANALYST_UNAVAILABLE);
    }
  });
  it("cancels an in-flight transport that ignores abort immediately", async () => {
    const transport = vi.fn().mockImplementation(() => new Promise(() => {})); vi.stubGlobal("fetch", transport);
    const controller = new AbortController();
    const handler = geminiAdapter("/llm").executeTurn(request, { signal: controller.signal });
    controller.abort();
    await expect(handler.complete).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
