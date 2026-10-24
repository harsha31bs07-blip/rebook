import type { AgAiEvent, AgAiToolCall, AgLlmAdapter, AgLlmRequest, AgLlmResponse } from "ag-studio";
import type { StudioChatRequest, StudioCompletion } from "../ai/studio-gemini";

type WireCall = NonNullable<StudioChatRequest["messages"][number]["tool_calls"]>[number];
type RememberedCall = { call: WireCall; turnId: string };
type SignedCall = AgAiToolCall & { extra_content?: WireCall["extra_content"]; rebook_turn_id?: string };

export function toChatRequest(request: AgLlmRequest, remembered: ReadonlyMap<string, RememberedCall> = new Map()): StudioChatRequest {
  const messages: StudioChatRequest["messages"] = [];
  let calls: WireCall[] = [];
  let results: StudioChatRequest["messages"] = [];
  let turnId: string | undefined;
  const flush = () => {
    if (calls.length) {
      const previous = messages.at(-1);
      if (previous?.role === "assistant" && !previous.tool_calls?.length) previous.tool_calls = calls;
      else messages.push({ role: "assistant", content: null, tool_calls: calls });
    }
    messages.push(...results);
    calls = []; results = []; turnId = undefined;
  };
  for (const item of request.input) {
    if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
      flush();
      const content = item.content.map((part) => part.type === "text" ? part.text : part.type === "refusal" ? part.refusal : "").join("\n");
      messages.push({ role: item.role, content });
    } else if (item.type === "function_call") {
      const signed = item as SignedCall;
      const cached = remembered.get(item.callId);
      const currentTurn = cached?.turnId ?? signed.rebook_turn_id;
      if (calls.length && currentTurn !== turnId) flush();
      turnId = currentTurn;
      const wire = cached?.call ?? { id: item.callId, type: "function", function: { name: item.name, arguments: item.arguments },
        ...(signed.extra_content ? { extra_content: signed.extra_content } : {}) };
      calls.push(wire);
    } else if (item.type === "function_call_output") {
      // Studio interleaves call/result pairs. Chat Completions requires every parallel
      // call on one assistant message, followed by its tool messages.
      results.push({ role: "tool", tool_call_id: item.callId, content: item.output });
    }
  }
  flush();
  return {
    messages, model: request.model?.id,
  };
}

export function fromChatCompletion(completion: StudioCompletion, remembered: Map<string, RememberedCall>) {
  const choice = completion.choices[0];
  const output: AgLlmResponse["output"] = [];
  const events: AgAiEvent[] = [];
  if (choice.message.content) {
    const id = `${completion.id}-text`;
    output.push({ id, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: choice.message.content, annotations: [] }] });
    events.push({ type: "TEXT_MESSAGE_CHUNK", messageId: id, role: "assistant", delta: choice.message.content });
  }
  for (const call of choice.message.tool_calls ?? []) {
    remembered.set(call.id, { call, turnId: completion.id });
    const item: SignedCall = { id: call.id, callId: call.id, kind: "output", type: "function_call", name: call.function.name, arguments: call.function.arguments, status: "completed", extra_content: call.extra_content, rebook_turn_id: completion.id };
    output.push(item);
    events.push({ type: "TOOL_CALL_CHUNK", toolCallId: call.id, toolCallName: call.function.name, delta: call.function.arguments });
  }
  const response: AgLlmResponse = { id: completion.id, createdAt: (completion.created ?? Date.now() / 1000) * 1000, output, model: completion.model,
    status: choice.finish_reason === "length" ? "incomplete" : "completed",
    ...(choice.finish_reason === "length" ? { incompleteDetails: { reason: "max_output_tokens" as const } } : {}),
  };
  return { response, events };
}

export function geminiAdapter(endpoint: string): AgLlmAdapter {
  // Studio has no provider-metadata slot. Keep exact wire calls by callId as well as on output
  // items, so the opaque Google signature survives even if Studio clones its conversation items.
  const remembered = new Map<string, RememberedCall>();
  return {
    executeTurn(request, options) {
      const pending = (async () => {
        const response = await fetch(endpoint, { method: "POST", signal: options?.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(toChatRequest(request, remembered)) });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error || "The recovery analyst is unavailable. Please try again shortly.");
        }
        return fromChatCompletion(await response.json(), remembered);
      })();
      const complete = pending.then((result) => result.response);
      // The stream consumer owns failures; avoid an unhandled rejection before it awaits complete.
      void complete.catch(() => {});
      return { complete, stream: { async *[Symbol.asyncIterator]() { for (const event of (await pending).events) yield event; } } };
    },
  };
}
