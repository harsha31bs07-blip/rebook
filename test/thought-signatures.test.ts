import { describe, expect, it } from "vitest";
import { withThoughtSignatures } from "../lib/ai/studio-request";

describe("thought signatures for Gemini tool-call history", () => {
  const call = (id: string, extra?: Record<string, unknown>) => ({ id, type: "function" as const, function: { name: "view_page", arguments: "{}" }, ...(extra ? { extra_content: extra } : {}) });

  it("adds the documented placeholder to calls Studio injected without a signature", () => {
    const [message] = withThoughtSignatures([{ role: "assistant", content: null, tool_calls: [call("a")] }]);
    expect(message.tool_calls?.[0].extra_content).toEqual({ google: { thought_signature: "skip_thought_signature_validator" } });
  });

  it("echoes model-produced signatures and other provider fields unchanged", () => {
    const signed = call("b", { google: { thought_signature: "real-signature" } });
    const partial = call("c", { google: { other: 1 }, vendor: true });
    const [message] = withThoughtSignatures([{ role: "assistant", content: null, tool_calls: [signed, partial] }]);
    expect(message.tool_calls?.[0]).toBe(signed);
    expect(message.tool_calls?.[1].extra_content).toEqual({ google: { other: 1, thought_signature: "skip_thought_signature_validator" }, vendor: true });
  });

  it("leaves messages without tool calls untouched", () => {
    const user: { role: string; content: string; tool_calls?: [] } = { role: "user", content: "Add a chart" };
    expect(withThoughtSignatures([user])[0]).toBe(user);
  });
});
