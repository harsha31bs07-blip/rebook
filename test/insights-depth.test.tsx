import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgAiTool, AgAiToolContext, AgAiToolInvocation, AgAiToolLabelParams, AgDefaultRegistry, AgFieldDefinition } from "ag-studio";
import { buildInsights } from "../lib/insights/data";
import { buildRecoveryAi, withDelegationSummary } from "../lib/insights/ai";
import { agentTools, recoveryDelegates } from "../lib/insights/agent-protocol";
import { heatmapCells, heatmapDayKey, heatmapDayLabel, heatmapWeekDays } from "../lib/insights/heatmap";
import { recoveryMetric } from "../lib/insights/metrics";
import { initialReport, reportLayout, reportPages, REPORT_TRACKS } from "../lib/insights/report";
import { buildStudioData } from "../lib/insights/studio-data";
import { seedStudio } from "../lib/seed/seed";
import { recoveryToolDisplay, toolRows } from "../components/insights/tool-cards";
import { customWidgets } from "../components/insights/widgets";

vi.mock("@/lib/insights/formatting", () => import("../lib/insights/formatting"));
vi.mock("@/lib/insights/report", () => import("../lib/insights/report"));
vi.mock("@/lib/insights/heatmap", () => import("../lib/insights/heatmap"));
vi.mock("@/lib/insights/metrics", () => import("../lib/insights/metrics"));
// Capture the public harness declaration, retaining the real toolkit-independent data code.
vi.mock("ag-studio", async (original) => ({
  ...await original<typeof import("ag-studio")>(),
  directLlmRunner: (definition: unknown) => definition,
  createAiHarness: (_api: unknown, builder: (context: Record<string, unknown>) => unknown) => builder({
    builtIn: Object.fromEntries(["lead", "planning", "data", "page", "widget"].map((id) => [id, { id }])),
    tools: { delegateTo: (targets: readonly string[]) => ({ name: "delegate_to", targets }) },
  }),
}));

describe("C4 Studio depth", () => {
  it("registers the heatmap's session mapping/form and supported table/chart exports", () => {
    const config = customWidgets({ widgets: [], menu: [], defaultType: "grid" });
    const heatmap = config.widgets.find((widget) => widget.id === "week-heatmap")!;
    expect(heatmap.defaultState?.dataMapping).toEqual({ rows: "id instructor local_day booked capacity disrupted".split(" ").map((id) => ({ id: `sessions.${id}` })) });
    expect(heatmap.defaultState?.format).toMatchObject({ crossFilter: "filter", style: { showValues: true } });
    expect(heatmap.form).toBeTypeOf("function");
    expect(config.menu[0].widgetIds).toContain("week-heatmap");
    const actions = (id: string) => config.widgets.find((widget) => widget.id === id)!.toolbar!.map((item) => typeof item === "string" ? item : item.id);
    expect(actions("grid")).toEqual(["duplicate", "delete", "export"]);
    expect(actions("bar-chart-grouped")).toEqual(["duplicate", "delete", "export", "download"]);
    expect(actions("column-chart-grouped")).toEqual(["duplicate", "delete", "export", "download"]);
  });

  it("aggregates utilisation per instructor/day without repeating session capacity", () => {
    const cells = heatmapCells([
      { instructor: "Maya", local_day: new Date(2026, 9, 26), booked: 8, capacity: 10, disrupted: false },
      { instructor: "Maya", local_day: "2026-10-26", booked: 4, capacity: 10, disrupted: true },
      { instructor: "Leo", local_day: "2026-10-26", booked: 0, capacity: 0 },
      { instructor: "Maya", local_day: "2026-10-27", booked: 3, capacity: 6 },
      { local_day: "2026-10-27", booked: 100, capacity: 100 },
    ]);
    expect(cells).toHaveLength(3);
    expect(cells[0]).toMatchObject({ instructor: "Maya", day: "2026-10-26", booked: 12, capacity: 20, utilisation: 0.6, disrupted: true });
    expect(cells[1].utilisation).toBe(0);
    expect(cells[2]).toMatchObject({ day: "2026-10-27", utilisation: 0.5 });
    expect(heatmapDayKey(cells[0].dayValue)).toBe("2026-10-26");
    expect(heatmapDayLabel("2026-10-26")).toBe("Mon Oct 26");
  });

  it("keeps the heatmap's viewer-local Date values on Monday and displays the workspace's seven days", () => {
    expect(heatmapDayKey(new Date(2026, 9, 26))).toBe("2026-10-26");
    const days = heatmapWeekDays("2026-10-26");
    expect(days).toHaveLength(7);
    expect(days.map(heatmapDayLabel)).toEqual(["Mon Oct 26", "Tue Oct 27", "Wed Oct 28", "Thu Oct 29", "Fri Oct 30", "Sat Oct 31", "Sun Nov 1"]);
    expect(days).not.toContain("2026-10-25");
  });

  it("hides empty delegation hand-backs while retaining real summaries and failures", async () => {
    const execute = vi.fn().mockResolvedValue({ success: true, response: "(the delegate finished without a summary)" });
    const tool: AgAiTool = { name: "delegate_to", description: "Delegate", kind: "client", schema: () => undefined, execute };
    const wrapped = withDelegationSummary(tool);
    const call = {} as AgAiToolInvocation, context = {} as AgAiToolContext;
    expect(await wrapped.execute!(call, context)).toEqual({ success: true, response: "" });
    const summary = { success: true, response: "Added a chart: Refunds by reason" };
    execute.mockResolvedValue(summary);
    expect(await wrapped.execute!(call, context)).toEqual(summary);
    const failure = { success: false, issues: [{ message: "Chart could not be added" }] };
    execute.mockResolvedValue(failure);
    expect(await wrapped.execute!(call, context)).toEqual(failure);
  });

  it("shows explicit empty KPI values and computes applied/issued totals in cents", () => {
    for (const metric of ["kept", "refunded"]) expect(recoveryMetric([], metric)).toEqual({ value: "$0", caption: "No disruptions yet" });
    expect(recoveryMetric([], "saved")).toEqual({ value: "-", caption: "No disruptions yet" });
    expect(recoveryMetric([{ applied_revenue_kept: 0.1 }, { applied_revenue_kept: 0.2 }], "kept").value).toBe("$0.30");
    expect(recoveryMetric([{ applied_saved: 4, applied_affected: 5 }, { applied_saved: 2, applied_affected: 5 }], "saved").value).toBe("60%");
    expect(recoveryMetric([{ applied_saved: 0, applied_affected: 0 }], "saved").value).toBe("-");
    expect(recoveryMetric([{ kind: "capture", issued_refund: 100 }, { kind: "refund", issued_refund: 25 }, { kind: "refund", issued_refund: 0 }], "refunded").value).toBe("$25");
    const overview = initialReport.pages[0].widgets!;
    for (const id of ["kept", "refunded", "saved"]) expect(overview[id]?.type).toBe("recovery-metric");
  });

  it("keeps dates, times and class/status keys sortable while using field formatters", () => {
    const data = buildInsights(seedStudio(), [], []);
    const model = buildStudioData(data);
    const sessions = model.sources.find((source) => source.id === "sessions")!;
    if (!("fields" in sessions)) throw new Error("Expected explicit session fields");
    const fields = sessions.fields!;
    const textField = (id: string) => fields.find((field) => field.id === id) as AgFieldDefinition<AgDefaultRegistry, unknown, "textFormat">;
    const start = textField("local_start");
    expect(data.sessions[0].local_start).toBe("07:00");
    const params = {} as Parameters<NonNullable<typeof start.createValueFormatter>>[1];
    const formatTime = start.createValueFormatter!(undefined, params);
    expect(formatTime("07:00")).toBe("7:00 AM");
    expect(formatTime("00:05")).toBe("12:05 AM");
    expect(formatTime("12:30")).toBe("12:30 PM");
    expect(fields.find((field) => field.id === "local_day")).toMatchObject({ format: "dateFormat", formatOptions: { format: "ddd mmm d" } });
    const classType = textField("class_type");
    expect(classType.createValueFormatter!(undefined, params)("hiit")).toBe("HIIT");
    expect(classType.createValueFormatter!(undefined, params)("yoga")).toBe("Yoga");
    expect(textField("status").createValueFormatter!(undefined, params)("cancelled")).toBe("Cancelled");
  });

  it("gives successful, empty, failed and cancelled tool steps human-readable cards", () => {
    const base: AgAiToolLabelParams = { args: {}, status: "done", fieldName: () => undefined, widgetName: () => undefined, tableName: () => undefined };
    const disruptions = { success: true as const, response: "Read", data: { disruptions: [{ disruption: "Maya, Monday", bookingsKept: 3, bookingsMoved: 2, plannedRefundsUSD: 25, completedRefundsUSD: 47, status: "executed" }] } };
    const receipts = { success: true as const, response: "Read", data: { receipts: Array.from({ length: 5 }, () => ({ customer: "Sam", class: "Yoga, Mon Oct 26 at 7:00 AM", amountUSD: 25, status: "COMPLETED", payment: "Real" })) } };
    expect(recoveryToolDisplay.get_disruptions.label({ ...base, result: disruptions })).toEqual({ text: "Looked up 1 disruption" });
    expect(recoveryToolDisplay.get_refund_receipts.label({ ...base, result: receipts })).toEqual({ text: "Read 5 refund receipts" });
    expect(recoveryToolDisplay.get_refund_receipts.label({ ...base, result: { success: true, response: "", data: { receipts: [] } } })).toEqual({ text: "Read 0 refund receipts" });
    expect(recoveryToolDisplay.get_disruptions.label({ ...base, result: { success: false, issues: [{ message: "Unavailable" }] } })).toEqual({ text: "Could not read disruptions" });
    expect(recoveryToolDisplay.get_disruptions.label({ ...base, status: "cancelled" })).toMatchObject({ pill: "Stopped" });
    expect(toolRows({ success: true, response: "", data: { receipts: [null, 7, { customer: "Sam" }] } }, "receipts")).toEqual([{ customer: "Sam" }]);
    const detail = recoveryToolDisplay.get_refund_receipts.detail!;
    const html = renderToStaticMarkup(createElement(detail, { name: "get_refund_receipts", args: {}, status: "done", result: receipts }));
    expect(html).toContain("Mon Oct 26 at 7:00 AM");
    expect(html).toContain("Completed");
    expect(html).not.toContain("get_refund_receipts");
    const disruptionHtml = renderToStaticMarkup(createElement(recoveryToolDisplay.get_disruptions.detail!, { name: "get_disruptions", args: {}, status: "done", result: disruptions }));
    expect(disruptionHtml).toContain("$25.00 in planned refunds");
    expect(disruptionHtml).toContain("$47.00 in completed refunds");
  });

  it("registers specialists for custom edits and direct tools for common questions and charts", () => {
    const tools = Object.fromEntries(["viewSchema", "executeQuery", "viewPage", "viewWidget"].map((name) => [name, () => ({ name })]));
    const setup = buildRecoveryAi("workspace123", buildInsights(seedStudio(), [], []));
    if (typeof setup !== "function") throw new Error("Expected a harness setup function");
    const config = setup({ api: { getAiTools: () => tools, defineAiTool: (definition: unknown) => definition } } as unknown as Parameters<typeof setup>[0]) as unknown as {
      primary: string; agents: { id: string; tools?: () => { name: string; targets?: string[] }[]; instructions?: () => string }[];
    };
    expect(config.primary).toBe("recovery-analyst");
    expect(config.agents.map((agent) => agent.id)).toEqual(["lead", "planning", "data", "page", "widget", "recovery-analyst"]);
    const analyst = config.agents.at(-1)!;
    expect(analyst.tools!().find((tool) => tool.name === "delegate_to")?.targets).toEqual(recoveryDelegates);
    expect(analyst.instructions!()).toMatch(/first delegate to page.*then delegate to widget/);
    expect(analyst.instructions!()).toContain("apply add_page_filter on sessions.instructor");
    expect(analyst.instructions!()).toContain("never delegate a common data question");
    expect(analyst.instructions!()).toContain("Do not delegate presets");
    expect(analyst.tools!().map((tool) => tool.name)).toEqual(agentTools["recovery-analyst"]);
    for (const id of recoveryDelegates) expect(agentTools[id]).toContain("complete_task");
  });

  it("fits three described pages into the measured canvas without overlapping widget bounds", () => {
    expect(reportPages.map((page) => page.id)).toEqual(["week-overview", "disruptions", "money"]);
    expect(reportPages.every((page) => page.description.length > 0)).toBe(true);
    expect(initialReport.pages.map((page) => page.id)).toEqual(reportPages.map((page) => page.id));
    for (const height of [350, 400, 450, 500]) {
      const layout = reportLayout(height);
      expect(REPORT_TRACKS * layout.rowHeight + layout.pagePadding * 2).toBeLessThanOrEqual(height);
    }
    for (const page of initialReport.pages) {
      const positions = Object.values(page.widgetLayout!).filter((position): position is NonNullable<typeof position> => Boolean(position));
      for (const [index, position] of positions.entries()) {
        expect(position.yTrack + position.ySpan).toBeLessThanOrEqual(REPORT_TRACKS);
        expect(position.xTrack + position.xSpan).toBeLessThanOrEqual(24);
        for (const other of positions.slice(index + 1)) expect(position.xTrack + position.xSpan <= other.xTrack || other.xTrack + other.xSpan <= position.xTrack || position.yTrack + position.ySpan <= other.yTrack || other.yTrack + other.ySpan <= position.yTrack).toBe(true);
      }
    }
    expect(initialReport.pages[2].widgets!.cashflow!.type).toBe("column-chart-grouped");
    expect(initialReport.pages[2].widgets!.net!.dataMapping).toEqual({ value: [{ id: "net_revenue_kpi" }] });
  });
});
