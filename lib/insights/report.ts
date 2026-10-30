import type { AgReportState } from "ag-studio";
import type { StudioRegistry } from "@/components/insights/widgets";

export const REPORT_STATE_VERSION = 6;
export const REPORT_TRACKS = 30;
export function reportLayout(canvasHeight: number) {
  return { rowHeight: Math.max(8, Math.floor((canvasHeight - 24) / REPORT_TRACKS)), pagePadding: 12, minWidth: 720 };
}
export const reportPages = [
  { id: "week-overview", label: "Week overview", description: "Bookings, recovery outcomes and instructor utilisation. Select a heatmap cell to explore a day." },
  { id: "disruptions", label: "Disruptions", description: "Applied and proposed recoveries, every booking action and its refund receipt." },
  { id: "money", label: "Money", description: "Captures less issued refunds, by receipt date in studio time. Simulated payments are included and labelled." },
];

const sum = (id: string) => ({ id, aggregation: "sum" as const });
const title = (text: string) => ({ title: { enabled: true, text } });
const barFormat = (text: string) => ({ ...title(text), style: { custom: { categoryAxis: { label: { fontSize: 11, spacing: 0 } } } } });
const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number) => ({ xTrack, yTrack, xSpan, ySpan });
const kpi = (text: string, value: { id: string; aggregation?: "sum" }, caption?: string) => ({ type: "value" as const, dataMapping: { value: [value] }, format: { ...title(text), ...(caption ? { caption: { enabled: true, text: caption, typography: { fontSize: 10 } } } : {}), style: { typography: { fontSize: 26, fontWeight: "bold" as const }, textScaling: { enabled: true } } } });
const metric = (text: string, metric: string, fields: string[]) => ({ type: "recovery-metric" as const, dataMapping: { rows: fields.map((id) => ({ id })) }, format: { ...title(text), style: { metric } } });
export const recoveryFields = "id subject window status kept moved credited kept_as_credit refunded pending no_reply simulated_refunded visits_returned applied_affected sessions_affected revenue_kept refund_amount created_at".split(" ").map((field) => ({ id: `disruptions.${field}` }));
export const receiptFields = [..."id kind paypal_id amount display_amount status created_at booking_id plan_id".split(" ").map((field) => ({ id: `money_events.${field}` })), { id: "customers.name" }];
export const heatmapFields = "id instructor local_day booked capacity disrupted".split(" ").map((field) => ({ id: `sessions.${field}` }));

export const initialReport: AgReportState<StudioRegistry> = {
  selectedPageId: "week-overview",
  panels: { data: { collapsed: true }, edit: { collapsed: true }, filters: { collapsed: true }, ai: { collapsed: true } },
  pages: [
    { id: "week-overview", widgets: {
      booked: kpi("Revenue booked", { id: "revenue_booked_kpi" }),
      kept: metric("Revenue kept through disruptions", "kept", ["disruptions.id", "disruptions.applied_revenue_kept"]),
      refunded: metric("Refunds issued", "refunded", ["money_events.id", "money_events.kind", "money_events.issued_refund", "money_events.visits_returned"]),
      saved: metric("Saved rate", "saved", ["disruptions.id", "disruptions.applied_saved", "disruptions.applied_affected"]),
      revenue: { type: "bar-chart-grouped", dataMapping: { categoryKey: [{ id: "sessions.class_type" }], valueKey: [sum("bookings.amount")] }, sort: [{ field: sum("bookings.amount"), direction: "desc" }], format: barFormat("Revenue by class type") },
      heatmap: { type: "week-heatmap", dataMapping: { rows: heatmapFields }, format: { ...title("Week heatmap · instructor utilisation"), crossFilter: "filter", style: { showValues: true } } },
      sessions: { type: "grid", dataMapping: { cols: "title local_day local_start instructor room capacity price status".split(" ").map((field) => ({ id: `sessions.${field}` })) }, sort: [{ field: { id: "sessions.start" }, direction: "asc" }], format: title("This week’s sessions") },
    }, widgetLayout: { booked: at(0, 0, 6, 7), kept: at(6, 0, 6, 7), refunded: at(12, 0, 6, 7), saved: at(18, 0, 6, 7), revenue: at(0, 7, 9, 11), heatmap: at(9, 7, 15, 11), sessions: at(0, 18, 24, 12) } },
    { id: "disruptions", widgets: {
      impact: { type: "recovery-impact", dataMapping: { rows: recoveryFields }, format: title("Recovery impact") },
      receipts: { type: "refund-receipts", dataMapping: { rows: receiptFields }, format: title("Refund receipts") },
      actions: { type: "grid", dataMapping: { cols: [{ id: "customers.name" }, { id: "booking_actions.action" }, { id: "booking_actions.reason" }, { id: "booking_actions.display_amount" }, { id: "disruptions.status" }] }, sort: [{ field: { id: "booking_actions.action" }, direction: "desc" }], format: title("Booking actions · every reason") },
      reasons: { type: "bar-chart-grouped", dataMapping: { categoryKey: [{ id: "money_events.reason" }], valueKey: [sum("money_events.issued_refund")] }, sort: [{ field: sum("money_events.issued_refund"), direction: "desc" }], format: barFormat("Refunds issued by reason") },
    }, filter: { widget: { reasons: [{ field: { id: "money_events.kind" }, model: { operator: "isIn", value: ["refund"] } }] } }, widgetLayout: { impact: at(0, 0, 13, 15), receipts: at(13, 0, 11, 15), actions: at(0, 15, 14, 15), reasons: at(14, 15, 10, 15) } },
    { id: "money", widgets: {
      credits: kpi("Kept as studio credit", { id: "studio_credit_kpi" }, "Revenue retained; included in net revenue"),
      wonBack: kpi("Won back from waitlist", { id: "waitlist_won_back_kpi" }, "Freed seats resold after a recovery"),
      net: kpi("Net revenue", { id: "net_revenue_kpi" }, "Captures less issued refunds"),
      cashflow: { type: "column-chart-grouped", dataMapping: { categoryKey: [{ id: "money_events.local_day" }], valueKey: [sum("money_events.captured"), sum("money_events.issued_refund")] }, sort: [{ field: { id: "money_events.local_day" }, direction: "asc" }], format: title("Captures vs refunds · receipt date") },
      receipts: { type: "refund-receipts", dataMapping: { rows: receiptFields }, format: title("Refund receipts") },
      ledger: { type: "grid", dataMapping: { cols: "local_day kind display_amount status payment_mode".split(" ").map((field) => ({ id: `money_events.${field}` })) }, sort: [{ field: { id: "money_events.created_at" }, direction: "desc" }], format: title("Payment ledger · latest status per request") },
    }, widgetLayout: { net: at(0, 0, 7, 7), credits: at(7, 0, 9, 7), wonBack: at(16, 0, 8, 7), cashflow: at(7, 7, 17, 10), receipts: at(0, 7, 7, 23), ledger: at(7, 17, 17, 13) } },
  ],
};

/** Application version is separate from AG Studio's own report version. */
export function restoreReportState(saved: string | null): AgReportState<StudioRegistry> {
  try {
    const stored = saved ? JSON.parse(saved) : null;
    const state = stored?.version === REPORT_STATE_VERSION ? stored.state : null;
    if (state && Array.isArray(state.pages) && state.pages.length &&
      state.pages.every((page: { id?: unknown } | null) => page && typeof page.id === "string") &&
      state.pages.some((page: { id: string }) => page.id === state.selectedPageId)) return state;
  } catch { /* Invalid or obsolete browser state falls back silently. */ }
  return initialReport;
}
