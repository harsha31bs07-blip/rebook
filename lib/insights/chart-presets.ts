import type { AgReportState, AgStudioApi } from "ag-studio";

export const chartPresets = ["revenue_by_class_type", "refunds_by_reason", "bookings_by_day", "kept_vs_refunded_by_disruption"] as const;
export type ChartPreset = typeof chartPresets[number];
const sum = (id: string) => ({ id, aggregation: "sum" as const });
export const presetWidgets = {
  revenue_by_class_type: { type: "bar-chart-grouped", dataMapping: { categoryKey: [{ id: "sessions.class_type" }], valueKey: [sum("bookings.amount"), sum("bookings.revenue_kept")] }, format: { title: { enabled: true, text: "Revenue by class type · booked vs kept (USD)" } } },
  refunds_by_reason: { type: "bar-chart-grouped", dataMapping: { categoryKey: [{ id: "money_events.reason" }], valueKey: [sum("money_events.issued_refund")] }, format: { title: { enabled: true, text: "Refunds issued by reason · includes simulations (USD)" } } },
  bookings_by_day: { type: "column-chart-grouped", dataMapping: { categoryKey: [{ id: "sessions.local_day" }], valueKey: [{ id: "bookings.id", aggregation: "count" }] }, sort: [{ field: { id: "sessions.local_day" }, direction: "asc" }], format: { title: { enabled: true, text: "Bookings by day · all statuses" } } },
  kept_vs_refunded_by_disruption: { type: "bar-chart-grouped", dataMapping: { categoryKey: [{ id: "disruptions.label" }], valueKey: [sum("disruptions.applied_kept"), sum("disruptions.applied_moved"), sum("disruptions.applied_refunded"), sum("disruptions.simulated_refunded")] }, format: { title: { enabled: true, text: "Applied bookings · kept, moved and refunded · simulations separate" } } },
} satisfies Record<ChartPreset, NonNullable<AgReportState["pages"][number]["widgets"]>[string]>;

/** Documented full immutable report state API; no schema discovery or delegated model turns. */
export function addPresetChart(api: Pick<AgStudioApi, "getState" | "setState">, preset: ChartPreset) {
  const state = api.getState();
  const page = state.pages.find((item) => item.id === state.selectedPageId);
  if (!page) throw new Error("The current report page is unavailable.");
  const widgetId = `recovery-preset-${preset}`;
  const existing = page.widgetLayout?.[widgetId];
  const bottom = Math.max(0, ...Object.entries(page.widgetLayout ?? {}).filter(([id]) => id !== widgetId).map(([, position]) => position ? position.yTrack + position.ySpan : 0));
  api.setState({ ...state, pages: state.pages.map((item) => item !== page ? item : { ...item,
    widgets: { ...item.widgets, [widgetId]: presetWidgets[preset] },
    widgetLayout: { ...item.widgetLayout, [widgetId]: existing ?? { xTrack: 0, yTrack: bottom, xSpan: 24, ySpan: 14 } },
    filter: { ...item.filter, widget: { ...item.filter?.widget, [widgetId]: preset === "refunds_by_reason" ? [{ field: { id: "money_events.kind" }, model: { operator: "isIn", value: ["refund"] } }] : [] } },
  }) });
  if (!api.getState().pages.find((item) => item.id === page.id)?.widgets?.[widgetId]) throw new Error("The chart could not be added.");
  return { chart: presetWidgets[preset].format.title.text, note: "Added to the current page; current report filters apply. Scroll down to view it." };
}
