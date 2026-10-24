import type { AgAiTool, AgAiStudioTools } from "ag-studio";
import type { ToolSchema, WebMcpTool } from "./bridge";

/** Only the documented read-only slice, never the report mutation tools. */
export function studioReadOnlyTools(toolkit: AgAiStudioTools): AgAiTool[] {
  return [toolkit.viewSchema(), toolkit.viewPage(), toolkit.viewWidget(), toolkit.executeQuery()];
}

export function studioTools(tools: readonly AgAiTool[]): WebMcpTool[] {
  return tools.flatMap((tool) => {
    const schema = tool.schema();
    if (!schema || !tool.execute) return [];
    const query = schema.name === "execute_query";
    const inputSchema = query ? { type: "object", properties: { query: schema.parameters }, required: ["query"], additionalProperties: false } : schema.parameters;
    return [{ name: schema.name, description: schema.description, inputSchema: inputSchema as ToolSchema, annotations: { readOnlyHint: true },
      execute: async (input, { signal }) => tool.execute!({ name: schema.name, toolCallId: `webmcp:${schema.name}`, args: query ? input.query as Record<string, unknown> : input }, {
        signal, run: { threadId: "webmcp", runId: "webmcp" },
        success: (response, data) => ({ success: true, response, data }),
        error: (messages) => ({ success: false, issues: (Array.isArray(messages) ? messages : [messages]).map((message) => ({ message })) }),
      }),
    }];
  });
}
