import type { AiProvider } from "./studio-transport";

// Delegated Page/Widget turns contain live schemas, report state and tool results (50+ KiB).
// Keep one byte ceiling for both wire contracts, including direct schema callers.
export const STUDIO_REQUEST_BYTES = 262_144;
export const studioRequestFits = (body: unknown) => new TextEncoder().encode(JSON.stringify(body)).byteLength <= STUDIO_REQUEST_BYTES;
export const STUDIO_REQUEST_TOO_LARGE = "This conversation is too large. Please start a new conversation.";

// Gemini 3 rejects history whose tool calls lack a thought signature. AG Studio injects calls
// (e.g. a delegated agent's initial view_page) that the model never produced, so those get
// Google's documented placeholder; model-produced signatures are echoed unchanged.
// https://ai.google.dev/gemini-api/docs/thought-signatures
type ToolCallLike = { extra_content?: Record<string, unknown> };
export function providerMessages<M extends { extra_content?: Record<string, unknown>; tool_calls?: ToolCallLike[] }>(messages: M[], provider: AiProvider): M[] {
  if (provider === "gemini") return withThoughtSignatures(messages);
  return messages.map((message) => {
    const clean = { ...message };
    delete clean.extra_content;
    if (clean.tool_calls) clean.tool_calls = clean.tool_calls.map((call) => {
      const cleanCall = { ...call };
      delete cleanCall.extra_content;
      return cleanCall;
    });
    return clean;
  });
}
export function withThoughtSignatures<M extends { tool_calls?: ToolCallLike[] }>(messages: M[]): M[] {
  return messages.map((message) => !message.tool_calls?.length ? message : {
    ...message,
    tool_calls: message.tool_calls.map((call) => {
      const google = call.extra_content?.google as Record<string, unknown> | undefined;
      return google?.thought_signature ? call : { ...call, extra_content: { ...call.extra_content, google: { ...google, thought_signature: "skip_thought_signature_validator" } } };
    }),
  });
}
