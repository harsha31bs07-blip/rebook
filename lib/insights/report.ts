import type { AgReportState } from "ag-studio";
import type { StudioRegistry } from "@/components/insights/widgets";

const sum = (id: string) => ({ id, aggregation: "sum" as const });
const title = (text: string) => ({ title: { enabled: true, text } });
const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number) => ({ xTrack, yTrack, xSpan, ySpan });
const kpi = (text: string, value: { id: string; aggregation?: "sum" }) => ({ type: "value" as const, dataMapping: { value: [value] }, format: { ...title(text), style: { typography: { fontSize: 26, fontWeight: "bold" as const } } } });
export const recoveryFields = "id subject window status kept moved refunded sessions_affected revenue_kept refund_amount created_at".split(" ").map((field) => ({ id: `disruptions.${field}` }));
export const receiptFields = [..."id kind paypal_id amount status created_at booking_id plan_id".split(" ").map((field) => ({ id: `money_events.${field}` })), { id: "customers.name" }];

export const initialReport: AgReportState<StudioRegistry> = {
  selectedPageId: "week-overview",
  panels: { data: { collapsed: true }, edit: { collapsed: true }, filters: { collapsed: true }, ai: { collapsed: true } },
  pages: [
    { id: "week-overview", widgets: {
      booked: kpi("Revenue booked", sum("bookings.amount")),
      kept: kpi("Revenue kept through disruptions", sum("disruptions.applied_revenue_kept")),
      refunded: kpi("Refunds issued · incl. simulated", sum("money_events.issued_refund")),
      saved: kpi("Saved rate · applied recoveries", { id: "saved_rate" }),
      revenue: { type: "bar-chart-grouped", dataMapping: { categoryKey: [{ id: "sessions.class_type" }], valueKey: [sum("bookings.amount")] }, format: title("Revenue by class type") },
      instructors: { type: "bar-chart-grouped", dataMapping: { categoryKey: [{ id: "instructors.name" }], valueKey: [{ id: "bookings.id", aggregation: "countd" }] }, format: title("Bookings by instructor") },
      sessions: { type: "grid", dataMapping: { cols: "title local_day local_start instructor room capacity price status".split(" ").map((field) => ({ id: `sessions.${field}` })) }, sort: [{ field: { id: "sessions.local_day" }, direction: "asc" }, { field: { id: "sessions.local_start" }, direction: "asc" }], format: title("This week’s sessions") },
    }, widgetLayout: { booked: at(0, 0, 6, 6), kept: at(6, 0, 6, 6), refunded: at(12, 0, 6, 6), saved: at(18, 0, 6, 6), revenue: at(0, 6, 12, 13), instructors: at(12, 6, 12, 13), sessions: at(0, 19, 24, 13) } },
    { id: "disruptions", widgets: {
      impact: { type: "recovery-impact", dataMapping: { rows: recoveryFields }, format: title("Recovery impact") },
      receipts: { type: "refund-receipts", dataMapping: { rows: receiptFields }, format: title("Refund receipts") },
      actions: { type: "grid", dataMapping: { cols: [{ id: "booking_actions.id" }, { id: "customers.name" }, { id: "booking_actions.action" }, { id: "booking_actions.reason" }, { id: "booking_actions.amount" }, { id: "disruptions.status" }] }, format: title("Booking actions · every reason") },
      reasons: { type: "bar-chart-grouped", dataMapping: { categoryKey: [{ id: "money_events.reason" }], valueKey: [sum("money_events.issued_refund")] }, format: title("Refunds issued by reason") },
    }, filter: { widget: { reasons: [{ field: { id: "money_events.kind" }, model: { operator: "isIn", value: ["refund"] } }] } }, widgetLayout: { impact: at(0, 0, 13, 15), receipts: at(13, 0, 11, 15), actions: at(0, 15, 14, 17), reasons: at(14, 15, 10, 17) } },
  ],
};
