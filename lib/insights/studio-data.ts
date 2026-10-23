import type { AgDataSourcesDefinition, AgFieldDefinition, AgFormat, AgRelationDefinition } from "ag-studio";
import type { Insights } from "./data";
import type { StudioRegistry } from "@/components/insights/widgets";

export const insightRelationships: AgRelationDefinition[] = [
  ["bookings", "session_id", "sessions"], ["bookings", "customer_id", "customers"],
  ["sessions", "instructor_id", "instructors"], ["sessions", "room_id", "rooms"],
  ["money_events", "booking_id", "bookings"], ["money_events", "plan_id", "disruptions"],
  ["booking_actions", "plan_id", "disruptions"], ["booking_actions", "booking_id", "bookings"],
].map(([tableId, fieldId, target]) => ({
  id: `${tableId}-${fieldId}`, type: "many-to-one", source: { tableId, fieldId }, target: { tableId: target, fieldId: "id" },
}));

const numeric = new Set(["amount", "price", "capacity", "sessions_affected", "kept", "moved", "refunded", "affected", "applied_affected", "applied_saved", "refund_amount", "revenue_kept", "applied_revenue_kept", "issued_refund"]);
const money = new Set(["amount", "price", "refund_amount", "revenue_kept", "applied_revenue_kept", "issued_refund"]);
// Explicit fields keep empty tables queryable before the first disruption/refund.
const columns = {
  sessions: "id class_type title instructor_id room_id instructor room local_day local_start start capacity price status",
  bookings: "id session_id customer_id status amount payment_mode capture_id",
  customers: "id name flexible loyal_to", instructors: "id name skills", rooms: "id name capacity",
  money_events: "id kind amount status paypal_id created_at booking_id plan_id reason issued_refund payment_mode",
  disruptions: "id kind subject window status sessions_affected kept moved refunded affected refund_amount revenue_kept applied_affected applied_saved applied_revenue_kept created_at covers",
  booking_actions: "id plan_id booking_id action reason amount",
} as const;

export function buildStudioData(data: Insights): AgDataSourcesDefinition<StudioRegistry> {
  return {
    description: `Rebook studio workspace in ${data.studio.timezone}. ${data.notes.join(" ")}`,
    sources: Object.entries(columns).map(([id, fields]) => ({
      id, name: id.replaceAll("_", " "), data: data[id as keyof typeof columns],
      fields: fields.split(" ").map((field): AgFieldDefinition => {
        const format: AgFormat = money.has(field) ? "currencyFormat" : numeric.has(field) ? "integerFormat" : field === "flexible" ? "booleanFormat" : "textFormat";
        return { id: field, name: field.replaceAll("_", " "), format, hide: field === "id" || field.endsWith("_id") };
      }),
    })),
    relationships: insightRelationships,
    expressions: [{
      id: "saved_rate", name: "Saved rate", isMeasure: true, format: "percentageFormat",
      expression: { operator: "divide", inputs: [{ id: "disruptions.applied_saved", aggregation: "sum" }, { id: "disruptions.applied_affected", aggregation: "sum" }] },
    }],
  };
}
