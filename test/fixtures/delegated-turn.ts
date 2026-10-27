import { initialReport } from "../../lib/insights/report";
import { buildStudioData } from "../../lib/insights/studio-data";
import { buildInsights } from "../../lib/insights/data";
import { seedStudio } from "../../lib/seed/seed";

/** Actual report, field schema and chart config; repeated page reads model a multi-turn edit. */
export function delegatedTurn() {
  const data = buildStudioData(buildInsights(seedStudio(), [], []));
  const fields = data.sources.flatMap((source) => "fields" in source ? source.fields?.map((field) => `${source.id}.${field.id}`) ?? [] : []);
  const call = { id: "read-page", type: "function", function: { name: "view_page", arguments: "{}" }, extra_content: { google: { thought_signature: "delegate-signature-exact==" } } };
  const messages = [
    { role: "user", content: "Add a bar chart of revenue by class type to this page" },
    { role: "assistant", content: null as string | null, tool_calls: [call] },
    { role: "tool", tool_call_id: call.id, content: JSON.stringify(initialReport) },
    { role: "user", content: JSON.stringify({ schema: fields, widget: initialReport.pages[0].widgets!.revenue }) },
  ];
  const result = { messages, harness: { agent: "page", instructions: "Add and position a bar-chart-grouped widget for revenue by sessions.class_type, SUM(bookings.amount). Keep exact field IDs.", tools: [
    { name: "add_widget", description: "Add a report widget", parameters: { type: "object", properties: { widgetType: { enum: ["bar-chart-grouped"] }, widgetId: { type: "string" }, fields: { type: "array", items: { enum: fields } } } } },
    { name: "complete_task", description: "Return confirmed results", parameters: { type: "object", properties: { summary: { type: "string" }, artifacts: { type: "array" } } } },
  ] } };
  while (Buffer.byteLength(JSON.stringify(result)) < 50_000) {
    const id = `page-${messages.length}`;
    messages.push({ role: "assistant", content: null, tool_calls: [{ ...call, id }] }, { role: "tool", tool_call_id: id, content: JSON.stringify(initialReport) });
  }
  return result;
}
