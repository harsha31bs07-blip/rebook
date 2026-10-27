import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgAiAgentRunner, AgAiEvent, AgAiHarnessConfig, AgAiRunInput, AgAiTool, AgAiToolContext, AgAiToolLabelParams, AgReportState, AgStudioApi } from "ag-studio";
import { buildInsights, type Insights } from "../lib/insights/data";
import { getRecoverySummary, getRefundBreakdown, getRevenueBreakdown, getCoverSummary } from "../lib/insights/analyst-tools";
import { buildRecoveryAi, recoveryInstructions } from "../lib/insights/ai";
import { addPresetChart, chartPresets, presetWidgets } from "../lib/insights/chart-presets";
import { initialReport } from "../lib/insights/report";
import { buildStudioData } from "../lib/insights/studio-data";
import { RecoveryHarnessSchema, providerBody, recoveryCompletion } from "../lib/insights/llm";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { applyPlan } from "../lib/solver/validate";
import { closeRepository, getRepository } from "../lib/store";
import { createCustomerLinks } from "../lib/choices/service";
import { recoveryToolDisplay } from "../components/insights/tool-cards";
import { limits } from "../lib/api/limits";

vi.mock("@/lib/insights/formatting", () => import("../lib/insights/formatting"));
// Keep the real SDK runner/adapter loop; capture only the harness declaration and delegation host.
vi.mock("ag-studio", async (original) => ({
  ...await original<typeof import("ag-studio")>(),
  createAiHarness: (_api: unknown, builder: (context: unknown) => unknown) => builder({
    builtIn: Object.fromEntries(["lead", "planning", "data", "page", "widget"].map((id) => [id, { id }])),
    tools: { delegateTo: () => ({ name: "delegate_to", kind: "client", description: "Delegate custom report edits",
      schema: () => ({ name: "delegate_to", description: "Delegate custom report edits", parameters: { type: "object", properties: { type: { type: "object", properties: { id: { enum: ["data", "page", "widget", "planning"] } } }, instructions: { type: "string" } } } }),
      execute: () => { throw new Error("A common question must not delegate"); },
    }) },
  }),
}));

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "rebook-analyst-")); vi.stubEnv("DATA_DIR", directory); limits.reset(); });
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function hero() {
  const repository = getRepository();
  const workspace = repository.createWorkspace(seedStudio());
  const plan = repository.createPlan(workspace.id, replan(workspace.state, demoDisruption));
  plan.status = "executed"; plan.basis = workspace.state; repository.savePlan(plan);
  const state = applyPlan(workspace.state, plan);
  createCustomerLinks(plan, workspace.state, state, repository);
  for (const action of plan.bookingActions.filter((row) => row.action === "refund")) repository.appendLedger({ workspaceId: workspace.id,
    bookingId: action.bookingId, kind: "refund", amount: action.amount, requestId: `${plan.id}:${action.bookingId}`,
    captureId: `cap-${action.bookingId}`, paypalId: `ref-${action.bookingId}`, status: "COMPLETED" });
  return { state, plan, workspace, data: buildInsights(state, [plan], repository.listLedger(workspace.id), repository.listCustomerLinks(workspace.id)) };
}

// The custom tools use only object/string/enum shapes. This host exposes their exact declared JSON
// schema through zod and validates arguments, without mounting a browser or loading remote data.
const builder = { object: z.object, enum: z.enum, string: () => z.string() };
type Definition = { name: string; description: string; params: (s: typeof builder) => z.ZodType; execute: (args: Record<string, unknown>, ctx: AgAiToolContext) => unknown };
function analyst(data: Insights) {
  let report = structuredClone(initialReport) as unknown as AgReportState;
  const setup = buildRecoveryAi("workspace123", data);
  if (typeof setup !== "function") throw new Error("Expected setup");
  const config = setup({ api: { getState: () => report, setState: (state: AgReportState) => { report = state; }, defineAiTool: (definition: Definition): AgAiTool => {
    const shape = definition.params(builder);
    return { name: definition.name, description: definition.description, kind: "client",
      schema: () => ({ name: definition.name, description: definition.description, kind: "client", parameters: z.toJSONSchema(shape) }),
      execute: async (call, ctx) => definition.execute(shape.parse(call.args) as Record<string, unknown>, ctx) as ReturnType<NonNullable<AgAiTool["execute"]>>,
    };
  } } } as unknown as Parameters<typeof setup>[0]) as unknown as AgAiHarnessConfig;
  const runner = config.agents.at(-1)! as AgAiAgentRunner;
  const context = {} as Parameters<NonNullable<typeof runner.tools>>[0];
  return { runner, tools: runner.tools!(context, undefined), instructions: runner.instructions!(context, undefined), report: () => report };
}

describe("direct analyst answers", () => {
  it("uses shared applied outcomes for hero totals and distinguishes no reply", () => {
    const { data } = hero();
    const result = getRecoverySummary(data);
    expect(result).toMatchObject({ kept: 9, moved: 16, refunded: 6, pending: 0, noReply: 25, revenueKept: 577, completedRefundAmount: 135, simulatedRefundAmount: 0 });
    expect(result.disruptions[0]).toMatchObject({ kept: 9, moved: 16, refunded: 6, revenueKept: 577, completedRefundAmount: 135 });
    expect(result.asOf).toBe(data.as_of);
    expect(JSON.stringify(result)).not.toContain(data.disruptions[0].id);
  });

  it.each(["reason", "class", "status"] as const)("breaks down hero refunds by %s without losing receipts", (group) => {
    const { data } = hero();
    const result = getRefundBreakdown(data, group);
    expect(result.rows.reduce((sum, row) => sum + row.requests, 0)).toBe(6);
    expect(result.rows.reduce((sum, row) => sum + row.completedUSD, 0)).toBe(135);
    expect(result.rows.every((row) => row.pendingUSD === 0 && row.simulatedUSD === 0 && row.failedUSD === 0)).toBe(true);
    expect(result.asOf).toBe(data.as_of);
  });

  it.each(["class_type", "instructor", "day"] as const)("groups booked and kept revenue by %s with recovery revenue of 577 USD", (group) => {
    const { data } = hero();
    const recoveryIds = new Set(data.recovery_outcomes.map((row) => row.booking_id));
    const affected = { ...data, bookings: data.bookings.filter((row) => recoveryIds.has(row.id)) };
    const result = getRevenueBreakdown(affected, group);
    expect(result.rows.reduce((sum, row) => sum + row.bookings, 0)).toBe(31);
    expect(result.rows.reduce((sum, row) => sum + row.bookedUSD, 0)).toBe(712);
    expect(result.rows.reduce((sum, row) => sum + row.keptUSD, 0)).toBe(577);
    const full = getRevenueBreakdown(data, group);
    const unaffected = data.bookings.filter((row) => !recoveryIds.has(row.id)).reduce((sum, row) => sum + row.amount, 0);
    expect(full.rows.reduce((sum, row) => sum + row.keptUSD, 0)).toBe(577 + unaffected);
    expect(result.asOf).toBe(data.as_of);
  });

  it("reports hero covered classes and distinguishes proposed cover from applied", () => {
    const { data, plan, workspace } = hero();
    const result = getCoverSummary(data);
    expect(result.rows).toHaveLength(plan.sessionChanges.filter((row) => row.remedy === "substitute").length);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((row) => row.originalInstructor === "Maya Chen" && row.coveringInstructor !== "Maya Chen" && row.status === "executed")).toBe(true);
    expect(result.asOf).toBe(data.as_of);
    const proposed = buildInsights(workspace.state, [{ ...plan, status: "proposed" }], []);
    expect(getRecoverySummary(proposed)).toMatchObject({ affected: 0, revenueKept: 0, completedRefundAmount: 0 });
    expect(getCoverSummary(proposed).rows.every((row) => row.status === "proposed")).toBe(true);
  });

  it("keeps latest pending, failed, simulated and choice receipts separate", () => {
    const { data } = hero();
    const event = data.money_events[0];
    const mixed = { ...data, money_events: [event, ...["PENDING", "FAILED", "SIMULATED"].map((status, index) => ({ ...event, id: `extra-${index}`, status, amount: index + 1 }))] };
    expect(getRefundBreakdown(mixed).rows[0]).toMatchObject({ completedUSD: event.amount, pendingUSD: 1, failedUSD: 2, simulatedUSD: 3 });
  });

  it("handles empty workspaces and sums money in cents", () => {
    const data = buildInsights(seedStudio(), [], []);
    expect(getRecoverySummary(data)).toMatchObject({ affected: 0, revenueKept: 0 });
    expect(getRefundBreakdown(data).rows).toEqual([]);
    expect(getCoverSummary(data).rows).toEqual([]);
    expect(getRevenueBreakdown({ ...data, bookings: data.bookings.slice(0, 2).map((row, index) => ({ ...row, amount: index ? 0.2 : 0.1, revenue_kept: index ? 0.2 : 0.1 })) }).rows[0]).toMatchObject({ bookedUSD: 0.3, keptUSD: 0.3 });
  });

  it("keeps refund cost with its originating disruption when a booking has a later recovery plan", () => {
    const { data } = hero();
    const original = data.disruptions[0];
    const latest = { ...original, id: "later", completed_refund_amount: 0 };
    const summary = getRecoverySummary({ ...data, disruptions: [original, latest], recovery_outcomes: data.recovery_outcomes.map((row) => ({ ...row, plan_id: latest.id })) });
    expect(summary.disruptions[0]).toMatchObject({ affected: 0, completedRefundAmount: 135 });
    expect(summary.disruptions[1]).toMatchObject({ affected: 31, completedRefundAmount: 0 });
    expect(summary).toMatchObject({ affected: 31, completedRefundAmount: 135 });
  });

  it("renders each direct tool card, timestamp, empty/error/cancelled states and chart confirmation", async () => {
    const { data } = hero();
    const { tools, report } = analyst(data);
    const ctx: AgAiToolContext = { signal: new AbortController().signal, run: { threadId: "t", runId: "r" },
      success: (response, result) => ({ success: true, response, data: result }), error: (message) => ({ success: false, issues: [{ message: String(message) }] }) };
    for (const name of ["get_recovery_summary", "get_refund_breakdown", "get_revenue_breakdown", "get_cover_summary"] as const) {
      const tool = tools.find((item) => item.name === name)!;
      const result = await tool.execute!({ name, toolCallId: name, args: {} }, ctx);
      const display = recoveryToolDisplay[name];
      const html = renderToStaticMarkup(createElement(display.detail!, { name, args: {}, status: "done", result }));
      expect(html).toContain(data.as_of); expect(html).not.toContain(name);
      expect(html).not.toContain("NaN"); expect(html).not.toContain("undefined");
      if (name === "get_recovery_summary") { expect(html).toContain("9 kept"); expect(html).toContain("$577.00 kept"); expect(html).toContain("$135.00 refunded"); }
      const label = { args: {}, status: "cancelled" } as AgAiToolLabelParams;
      expect(display.label(label)).toMatchObject({ pill: "Stopped" });
      expect(renderToStaticMarkup(createElement(display.detail!, { name, args: {}, status: "done", result: { success: false, issues: [{ message: "failed" }] } }))).toContain("could not be completed");
    }
    expect(renderToStaticMarkup(createElement(recoveryToolDisplay.get_cover_summary.detail!, { name: "get_cover_summary", args: {}, status: "done", result: ctx.success("", { rows: [], asOf: data.as_of }) }))).toContain("No matching records");
    const preset = tools.find((tool) => tool.name === "add_preset_chart")!;
    const chartResult = await preset.execute!({ name: preset.name, toolCallId: "chart", args: { preset: "revenue_by_class_type" } }, ctx);
    expect(chartResult.success).toBe(true);
    expect(report().pages[0].widgets!["recovery-preset-revenue_by_class_type"]).toBeDefined();
    expect(renderToStaticMarkup(createElement(recoveryToolDisplay.add_preset_chart.detail!, { name: preset.name, args: {}, status: "done", result: chartResult }))).toContain("Revenue by class type");
    await expect(preset.execute!({ name: preset.name, toolCallId: "invalid", args: { preset: "arbitrary" } }, ctx)).rejects.toThrow();
  });

  it.each(chartPresets)("adds %s with the Studio state API, reuses it and preserves the current page", (preset) => {
    let state = structuredClone(initialReport) as unknown as AgReportState;
    const original = state;
    const api = { getState: () => state, setState: vi.fn((value: AgReportState) => { state = value; }) } as unknown as Pick<AgStudioApi, "getState" | "setState">;
    const result = addPresetChart(api, preset);
    const page = state.pages[0], widgetId = `recovery-preset-${preset}`;
    expect(api.setState).toHaveBeenCalledTimes(1);
    expect(page.widgets![widgetId]).toEqual(presetWidgets[preset]);
    expect(page.widgetLayout![widgetId]).toMatchObject({ yTrack: 30, xSpan: 24 });
    expect(state.pages[1]).toBe(original.pages[1]);
    expect(original.pages[0].widgets![widgetId]).toBeUndefined();
    expect(result.chart).toBeTruthy();
    addPresetChart(api, preset);
    expect(Object.keys(state.pages[0].widgets!).filter((id) => id === widgetId)).toHaveLength(1);
    expect(state.pages[0].widgetLayout![widgetId]?.yTrack).toBe(30);
    state = { ...state, selectedPageId: state.pages[2].id };
    addPresetChart(api, preset);
    expect(state.pages[2].widgets![widgetId]).toBeDefined();
    const fields = new Set(buildStudioData(hero().data).sources.flatMap((source) => ("fields" in source ? source.fields ?? [] : []).map((field) => `${source.id}.${field.id}`)));
    for (const mapping of Object.values(presetWidgets[preset].dataMapping)) for (const field of mapping) expect(fields.has(field.id), field.id).toBe(true);
  });

  it("fails a preset cleanly if the current page is missing", () => {
    expect(() => addPresetChart({ getState: () => ({ pages: [], selectedPageId: "missing" }), setState: vi.fn() }, "bookings_by_day")).toThrow("unavailable");
  });

  it("answers a simple question in the real SDK loop without delegation and fits the Groq gate before and after tools", async () => {
    const { data, state } = hero();
    const { runner, tools, instructions } = analyst(data);
    expect(instructions).toBe(recoveryInstructions(data));
    expect(instructions).toContain("never delegate a common data question");
    expect(instructions).toContain("Do not delegate presets");
    expect(tools.some((tool) => ["view_schema", "execute_query"].includes(tool.name))).toBe(false);
    const bodies: unknown[] = [];
    vi.stubEnv("AI_MODELS", "groq:analyst-test"); vi.stubEnv("GROQ_API_KEY", "test"); vi.stubEnv("GROQ_MAX_INPUT_TOKENS", "7000");
    const fetch = vi.fn(async (url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      if (url.startsWith("/api/")) {
        const parsed = RecoveryHarnessSchema.parse(body);
        const provider = providerBody(parsed, state, { provider: "groq", model: "analyst-test" });
        expect(Math.ceil(new TextEncoder().encode(JSON.stringify(provider)).byteLength / 8)).toBeLessThan(7000);
        bodies.push(parsed);
        return Response.json(await recoveryCompletion(parsed, new AbortController().signal, { client: "test", workspace: "test" }, state));
      }
      expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
      const hasResult = body.messages.some((message: { role: string }) => message.role === "tool");
      return Response.json({ id: hasResult ? "answer" : "direct", choices: [{ message: hasResult ? { role: "assistant", content: `Revenue compared by class type. Data as of ${data.as_of}.` }
        : { role: "assistant", tool_calls: [{ id: "revenue", type: "function", function: { name: "get_revenue_breakdown", arguments: '{"group_by":"class_type"}' } }] }, finish_reason: "stop" }] });
    });
    vi.stubGlobal("fetch", fetch);
    const input: AgAiRunInput = { threadId: "t", runId: "r", messages: [{ id: "u", role: "user", content: "Which class type earns the most revenue this week?" }], tools: [], state: {}, context: [], forwardedProps: {} };
    const events: AgAiEvent[] = [];
    for await (const event of runner.run(input, { params: undefined, instructions: () => instructions, tools: () => tools })) events.push(event);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    expect(bodies).toHaveLength(2);
    expect(events.some((event) => "toolCallName" in event && event.toolCallName === "delegate_to")).toBe(false);
    expect(events.some((event) => "toolCallName" in event && event.toolCallName === "get_revenue_breakdown")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(4); // two browser proxy turns, two mocked Groq calls
  });
});
