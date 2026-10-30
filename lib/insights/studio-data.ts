import type { AgDataSourcesDefinition, AgFieldDefinition, AgFormat, AgRelationDefinition } from "ag-studio";
import type { Insights } from "./data";
import type { StudioRegistry } from "@/components/insights/widgets";
import { localTimeLabel, titleCase } from "./formatting";

// Link receipts through their exact recovery action, giving each pair of tables one join path.
// Joining receipts separately to both bookings and plans creates an ambiguous diamond.
export const insightRelationships: AgRelationDefinition[] = [
  ["bookings", "session_id", "sessions"], ["bookings", "customer_id", "customers"],
  ["sessions", "instructor_id", "instructors"], ["sessions", "room_id", "rooms"],
  ["money_events", "booking_action_id", "booking_actions"],
  ["credits", "booking_id", "bookings"],
  ["booking_actions", "plan_id", "disruptions"], ["booking_actions", "booking_id", "bookings"],
].map(([tableId, fieldId, target]) => ({
  id: `${tableId}-${fieldId}`, type: "many-to-one", source: { tableId, fieldId }, target: { tableId: target, fieldId: "id" },
}));

const creditAmounts = ["kept_as_credit", "remaining", "redeemed"];
const refundAmounts = ["planned_refund_amount", "completed_refund_amount", "pending_refund_amount", "simulated_refund_amount", "failed_refund_amount"];
const numeric = new Set(["amount", "price", "capacity", "booked", "captured", "net", "sessions_affected", "kept", "credited", "moved", "refunded", "affected", "applied_affected", "applied_saved", "applied_kept", "applied_moved", "applied_refunded", "pending", "no_reply", "simulated_refunded", "visits_returned", "refund_amount", "revenue_kept", "applied_revenue_kept", "issued_refund", ...creditAmounts, ...refundAmounts]);
numeric.add("pack_balance");
const money = new Set(["amount", "price", "captured", "net", "refund_amount", "revenue_kept", "applied_revenue_kept", "issued_refund", ...creditAmounts, ...refundAmounts]);
// Explicit fields keep empty tables queryable before the first disruption/refund.
const labels: Record<string, string> = { title: "Class", class_type: "Class type", local_day: "Day", local_start: "Start", name: "Customer", refund_amount: "Planned refund amount", kept_as_credit: "Kept as studio credit", display_amount: "Amount" };
const columns = {
  sessions: "id class_type title instructor_id room_id instructor room local_day local_start start capacity booked disrupted price status",
  bookings: "id session_id customer_id status amount revenue_kept payment_mode capture_id pack_balance",
  customers: "id name flexible loyal_to", instructors: "id name skills", rooms: "id name capacity",
  money_events: "id kind amount status paypal_id created_at local_day captured net booking_id plan_id booking_action_id reason issued_refund payment_mode visits_returned display_amount",
  disruptions: `id kind subject window label status sessions_affected kept credited kept_as_credit moved refunded pending no_reply simulated_refunded visits_returned affected refund_amount ${refundAmounts.join(" ")} revenue_kept applied_affected applied_saved applied_kept applied_moved applied_refunded applied_revenue_kept created_at covers`,
  credits: "id booking_id customer_id plan_id amount remaining redeemed status created_at",
  booking_actions: "id plan_id booking_id action reason amount display_amount",
} as const;

export function buildStudioData(data: Insights): AgDataSourcesDefinition<StudioRegistry> {
  return {
    description: `Rebook studio workspace in ${data.studio.timezone}. ${data.notes.join(" ")}`,
    sources: Object.entries(columns).map(([id, fields]) => ({
      id, name: id.replaceAll("_", " "), data: data[id as keyof typeof columns],
      fields: fields.split(" ").map((field): AgFieldDefinition => {
        const format: AgFormat = money.has(field) ? "currencyFormat" : numeric.has(field) ? "integerFormat" : ["flexible", "disrupted"].includes(field) ? "booleanFormat" : field === "local_day" ? "dateFormat" : ["start", "created_at"].includes(field) ? "dateTimeFormat" : "textFormat";
        return { id: field, name: field === "name" && id !== "customers" ? titleCase(id.slice(0, -1)) : labels[field] ?? titleCase(field), format,
          ...(money.has(field) ? { formatOptions: { format: "$#,##0.00" } } : {}),
          ...(field === "local_day" ? { formatOptions: { format: "ddd mmm d" } } : {}),
          ...(field === "local_start" ? { createValueFormatter: () => localTimeLabel } : {}),
          ...(["start", "created_at"].includes(field) ? { formatOptions: { format: new Intl.DateTimeFormat("en-US", { timeZone: data.studio.timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) } } : {}),
          ...(["status", "action", "class_type", "kind", "payment_mode"].includes(field) ? { createValueFormatter: () => (value: string) => value.toLowerCase() === "hiit" ? "HIIT" : titleCase(value) } : {}),
          hide: field === "id" || field.endsWith("_id") };
      }),
    })),
    relationships: insightRelationships,
    expressions: [
      ...[["revenue_booked_kpi", "Revenue booked", "bookings.amount"], ["revenue_kept_kpi", "Revenue kept", "disruptions.applied_revenue_kept"], ["refunds_issued_kpi", "Refunds issued", "money_events.issued_refund"], ["studio_credit_kpi", "Kept as studio credit", "disruptions.kept_as_credit"], ["net_revenue_kpi", "Net revenue", "money_events.net"]].map(([id, name, field]) => ({
        id, name, isMeasure: true, format: "currencyFormat" as const, formatOptions: { format: "$#,##0" },
        expression: { id: field, aggregation: "sum" as const },
      })),
      {
      id: "saved_rate", name: "Saved rate", isMeasure: true, format: "percentageFormat",
      expression: { operator: "divide", inputs: [{ id: "disruptions.applied_saved", aggregation: "sum" }, { id: "disruptions.applied_affected", aggregation: "sum" }] },
    }],
  };
}
