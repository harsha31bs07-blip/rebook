"use client";

import { useEffect, useState } from "react";
import { createWidgets, type AgAiToolDisplay, type AgWidgetDefinition } from "ag-studio-react";
import type { AgDefaultRegistry, AgRowsResult, AgStudioApi, AgWidgetDataFormat, AgWidgetFieldReference, AgWidgetParams, AgWidgetsConfig, AgWidgetToolbarItem } from "ag-studio";
import { heatmapFields, receiptFields, recoveryFields } from "@/lib/insights/report";
import { heatmapCells, heatmapDayKey, heatmapDayLabel } from "@/lib/insights/heatmap";
import { recoveryMetric } from "@/lib/insights/metrics";
import { titleCase } from "@/lib/insights/formatting";
import styles from "./insights.module.css";

type CustomFormat = AgWidgetDataFormat<{ planId?: string; showValues?: boolean; metric?: string }>;
export type RecoveryWidget = { type: "recovery-impact"; dataMapping: { rows: AgWidgetFieldReference[] }; format?: CustomFormat };
export type ReceiptsWidget = { type: "refund-receipts"; dataMapping: { rows: AgWidgetFieldReference[] }; format?: CustomFormat };
export type HeatmapWidget = { type: "week-heatmap"; dataMapping: { rows: AgWidgetFieldReference[] }; format?: CustomFormat };
export type MetricWidget = { type: "recovery-metric"; dataMapping: { rows: AgWidgetFieldReference[] }; format?: CustomFormat };
export interface StudioRegistry extends Omit<AgDefaultRegistry, "widgets" | "aiToolDisplay"> {
  aiToolDisplay: AgAiToolDisplay;
  widgets: readonly (AgDefaultRegistry["widgets"][number] | AgWidgetDefinition<"recovery-impact", RecoveryWidget> | AgWidgetDefinition<"refund-receipts", ReceiptsWidget> | AgWidgetDefinition<"week-heatmap", HeatmapWidget> | AgWidgetDefinition<"recovery-metric", MetricWidget>)[];
}
type Row = Record<string, unknown>;
const money = (value: unknown) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(value) || 0);

function useWidgetRows(params: AgWidgetParams<RecoveryWidget | ReceiptsWidget | HeatmapWidget | MetricWidget>) {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const { dataMapping, widgetApi } = params;
  useEffect(() => {
    let current = true;
    const fields = dataMapping.rows ?? [];
    if (!fields.length) { widgetApi.setDisplayState("incompleteDataMapping"); return; }
    widgetApi.setDisplayState("loading", { prominent: false });
    widgetApi.getData({ fields }, { crossFilter: params.widgetType === "week-heatmap" ? "none" : "filter" }).then(({ results }) => {
      if (!current) return;
      const normalized = results.rows.map((row) => Object.fromEntries(fields.map((field) => [field.fieldId.split(".").at(-1)!, row[field.key]])));
      setRows(normalized); setError(""); widgetApi.setDisplayState("displayed");
    }).catch(() => { if (current) { setError("Could not load widget data. Try refreshing the report."); widgetApi.setDisplayState("displayed"); } });
    return () => { current = false; };
  }, [params, dataMapping, widgetApi]);
  return { rows, error };
}

function RecoveryMetric(params: AgWidgetParams<MetricWidget>) {
  const { rows, error } = useWidgetRows(params);
  const { value, caption } = recoveryMetric(rows, params.format?.style?.metric);
  return <div className={styles.metric}><strong>{error ? "-" : value}</strong><span>{error || caption}</span></div>;
}

function WeekHeatmap(params: AgWidgetParams<HeatmapWidget>) {
  const { rows, error } = useWidgetRows(params);
  const cells = heatmapCells(rows);
  const days = [...new Set(cells.map((cell) => cell.day))].sort();
  const instructors = [...new Set(cells.map((cell) => cell.instructor))].sort();
  const instructorField = (params.dataMapping.rows ?? []).find((field) => field.fieldId === "sessions.instructor");
  const dayField = (params.dataMapping.rows ?? []).find((field) => field.fieldId === "sessions.local_day");
  const selections = params.widgetApi.getCrossFilterSelections();
  const selected = (instructor: string, day: string) => selections?.some((selection) => selection.type === "multiValue" && selection.values.some((pairs) => pairs.some((pair) => pair.field.key === instructorField?.key && pair.value === instructor) && pairs.some((pair) => pair.field.key === dayField?.key && heatmapDayKey(pair.value) === day)));
  if (error) return <p role="alert">{error}</p>;
  if (!cells.length) return <p className="insight-empty">No classes match these filters.</p>;
  return <div className={styles.heatmap}>
    <div className={styles.heatmapGrid} style={{ gridTemplateColumns: `minmax(76px, 1fr) repeat(${days.length}, minmax(50px, 1fr))` }}>
      <span />{days.map((day) => <span className={styles.day} key={day}>{heatmapDayLabel(day)}</span>)}
      {instructors.map((instructor) => <div className={styles.heatmapRow} key={instructor}><strong>{instructor}</strong>{days.map((day) => {
        const cell = cells.find((item) => item.instructor === instructor && item.day === day);
        return <button key={day} disabled={!cell || !instructorField || !dayField} aria-pressed={Boolean(selected(instructor, day))}
          aria-label={`${instructor}, ${heatmapDayLabel(day)}: ${cell ? `${cell.booked} of ${cell.capacity} booked, ${Math.round(cell.utilisation * 100)}% utilised${cell.disrupted ? ", disrupted" : ""}` : "No classes"}`}
          className={styles.cell} style={{ backgroundColor: cell ? `rgba(29, 78, 216, ${0.08 + Math.min(cell.utilisation, 1) * 0.72})` : "#f1f5f9", color: cell && cell.utilisation > 0.6 ? "white" : "#1e293b", backgroundImage: cell?.disrupted ? "repeating-linear-gradient(135deg, transparent, transparent 5px, rgba(180,83,9,.4) 5px, rgba(180,83,9,.4) 7px)" : undefined }}
          onClick={() => { if (instructorField && dayField) params.widgetApi.toggleCrossFilter({ type: "multiValue", group: 0, reset: true, values: [{ field: instructorField, value: instructor }, { field: dayField, value: cell?.dayValue }] }); }}>
          {!cell ? "—" : params.format?.style?.showValues === false ? "\u00a0" : `${Math.round(cell.utilisation * 100)}%`}
        </button>;
      })}</div>)}
    </div>
    <div className={styles.heatmapLegend}><span>Light → dark: booked / capacity · Hatched: disrupted</span><button onClick={() => params.widgetApi.resetCrossFilter()}>Clear selection</button></div>
  </div>;
}

function RecoveryImpact(params: AgWidgetParams<RecoveryWidget>) {
  const { rows, error } = useWidgetRows(params);
  const [receipts, setReceipts] = useState<Row[]>();
  const [receiptError, setReceiptError] = useState(false);
  useEffect(() => {
    let current = true;
    // Query existing ledger fields, independently of a saved report's recovery mapping.
    void params.widgetApi.getData<AgRowsResult>({ projection: [
      ["plan_id", "refundPlan"], ["kind", "refundKind"], ["status", "refundStatus"], ["amount", "refundAmount"],
    ].map(([fieldId, as]) => ({ field: { key: `money_events.${fieldId}`, sourceId: "money_events", fieldId: `money_events.${fieldId}` }, as })) },
    { queryId: "refund-totals", filter: false, crossFilter: "none" }).then(({ results }) => {
      if (!current) return;
      if (results.dataShape !== "rows") throw new Error("Refund totals unavailable");
      setReceipts(results.rows); setReceiptError(false);
    }).catch(() => { if (current) setReceiptError(true); });
    return () => { current = false; };
  }, [params]);
  const sorted = [...rows].sort((a, b) => new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime());
  const selectedId = params.format?.style?.planId;
  const selected = sorted.find((row) => row.id === selectedId) ?? sorted[0];
  const select = (planId: string) => {
    const api = params.api as AgStudioApi<StudioRegistry>;
    const state = api.getState();
    api.setState({ ...state, pages: state.pages.map((page) => {
      const widget = page.widgets?.[params.widgetId];
      if (widget?.type !== "recovery-impact") return page;
      return { ...page, widgets: { ...page.widgets, [params.widgetId]: { ...widget, format: { ...params.format, style: { ...params.format?.style, planId } } } } };
    }) });
  };
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!selected) return <div className="insight-empty"><strong>Your next recovery, in perspective</strong><p>Create a disruption from the schedule to see bookings saved and refunds here.</p></div>;
  const kept = Number(selected.kept) || 0, moved = Number(selected.moved) || 0, refunded = Number(selected.refunded) || 0;
  const affected = kept + moved + refunded;
  const refunds = receipts?.filter((row) => row.refundKind === "refund" && row.refundPlan === selected.id);
  const refundAmount = (statuses: string[]) => (refunds ?? []).filter((row) => statuses.includes(String(row.refundStatus)))
    .reduce((sum, row) => sum + Math.round(Number(row.refundAmount) * 100), 0) / 100;
  return <div className="recovery-impact">
    <label>Disruption<select aria-label="Selected disruption" value={String(selected.id)} onChange={(event) => select(event.target.value)}>{sorted.map((row) => <option key={String(row.id)} value={String(row.id)}>{String(row.subject)} · {String(row.window)}</option>)}</select></label>
    <div className="impact-headline"><strong>{money(selected.revenue_kept)} kept <span>{receiptError ? "Refund totals unavailable" : receipts ? `${money(refundAmount(["COMPLETED"]))} refunded · ${money(refundAmount(["REQUESTED", "PENDING"]))} pending · ${money(refundAmount(["SIMULATED"]))} simulated` : "Loading refund totals…"}</span></strong><span className="pill success-pill">{affected ? Math.round((kept + moved) / affected * 100) : 0}% saved</span></div>
    <p className="muted">{money(selected.refund_amount)} in planned refunds</p>
    <div className="impact-bar" role="img" aria-label={`${kept} kept, ${moved} moved, ${refunded} refund actions`}>
      {[kept, moved, refunded].map((count, index) => count > 0 && <span className={`impact-segment impact-${index}`} key={index} style={{ flex: count }} />)}
    </div>
    <div className="impact-legend"><span><i className="impact-0" />{kept} Kept</span><span><i className="impact-1" />{moved} Moved</span><span><i className="impact-2" />{refunded} Refund actions</span></div>
    <p className="muted">{String(selected.status) === "proposed" ? "Proposed recovery · forecast" : "Applied recovery"} · {String(selected.sessions_affected)} classes affected</p>
  </div>;
}

function RefundReceipts(params: AgWidgetParams<ReceiptsWidget>) {
  const { rows, error } = useWidgetRows(params);
  const refunds = rows.filter((row) => row.kind === "refund" && (!params.format?.style?.planId || row.plan_id === params.format.style.planId)).sort((a, b) => new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime());
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!refunds.length) return <div className="insight-empty"><strong>No refund receipts yet</strong><p>Approved refunds will appear here with their PayPal reference and latest status.</p></div>;
  return <div className="receipt-list" aria-label="Refund receipts">{refunds.map((row) => {
    const status = String(row.status);
    const label = ["PENDING", "REQUESTED"].includes(status) ? "Pending" : titleCase(status);
    return <article className="receipt" key={String(row.id)}><div><strong>{String(row.name ?? row.booking_id)}</strong><strong>{money(row.amount)}</strong></div><div><code>{String(row.paypal_id || "Awaiting PayPal reference")}</code><span className={`action-pill receipt-${label.toLowerCase()}`}>{label}</span></div></article>;
  })}</div>;
}

const formatShape: AgWidgetDefinition<"recovery-impact", RecoveryWidget>["formatShape"] = ({ api }) =>
  // The command factory exposes Studio's public shape builder and returns a reusable shape.
  api.defineAiCommand((s) => {
    const title = () => s.object({
      enabled: s.boolean().optional(), text: s.string().optional(), color: s.string().optional(),
      textAlign: s.enum(["left", "center", "right"]).optional(), wrapping: s.boolean().optional(),
      typography: s.object({ fontFamily: s.string().optional(), fontSize: s.number().optional(),
        fontWeight: s.enum(["normal", "bold"]).optional(), fontStyle: s.enum(["normal", "italic"]).optional(),
      }).optional(),
    }).optional();
    return {
      input: s.object({
        title: title(), subtitle: title(), caption: title(),
        crossFilter: s.enum(["filter", "none", "highlight"]).optional(),
        widget: s.object({ backgroundColor: s.string().optional(), borderRadius: s.number().optional(),
          borderEnabled: s.boolean().optional(), borderWidth: s.number().optional(), borderColor: s.string().optional(),
        }).optional(),
        style: s.object({ planId: s.string({ description: "Disruption plan ID, or omit for latest/all receipts." }).optional(), showValues: s.boolean().optional(), metric: s.enum(["kept", "saved", "refunded"]).optional() }).optional(),
      }),
      execute: () => ({ success: true, value: undefined }),
    };
  }).shape;

const baseDefinition: Omit<AgWidgetDefinition<"recovery-impact", RecoveryWidget>, "id" | "comp" | "label"> = {
    formatShape,
    dataMapping: { rows: { type: "fieldset", supportedRoles: ["category", "numeric", "temporal"], required: true, aiDescription: "All detail fields including the unique row ID. Recovery: disruptions table. Receipts: money_events joined to customers.name." } },
    form: (params) => {
      const form = params.createDefaults({ dataMappingItems: [{ key: "rows", label: "Detail fields" }] });
      form.items[0].items.push({ type: "section", key: "recovery", label: "Disruption", items: [
        { type: "textfield", id: "format.style.planId", label: "Plan ID (blank for latest / all receipts)", defaultValue: "" },
      ] });
      form.items[1].items.push(params.createWidgetAppearanceSection());
      return form;
    },
    defaultSize: { width: 560, height: 240 }, minSize: { width: 280, height: 180 },
};

export const customWidgets = (defaults: AgWidgetsConfig<AgDefaultRegistry>) => {
  const configured = createWidgets<StudioRegistry>({
  additionalTypes: [
    { ...baseDefinition, id: "recovery-impact", label: "Recovery impact", comp: RecoveryImpact, defaultState: { dataMapping: { rows: recoveryFields } }, ai: { description: "Stacked kept/moved/refunded bookings, revenue retained and saved rate for a selected disruption." } },
    { ...baseDefinition, id: "refund-receipts", label: "Refund receipts", comp: RefundReceipts, defaultState: { dataMapping: { rows: receiptFields } }, ai: { description: "Refund receipts with PayPal IDs, customers, amounts and latest payment status." } },
    { ...baseDefinition, id: "week-heatmap", label: "Week heatmap", comp: WeekHeatmap, minSize: { width: 460, height: 140 }, defaultState: { dataMapping: { rows: heatmapFields }, format: { crossFilter: "filter", style: { showValues: true } } },
      form: (params) => { const form = params.createDefaults({ dataMappingItems: [{ key: "rows", label: "Session fields (instructor, day, booked, capacity, disrupted)" }] }); form.items[1].items.push({ type: "section", key: "heatmap", label: "Heatmap", items: [{ type: "checkbox", id: "format.style.showValues", label: "Show utilisation percentages", defaultValue: true }] }, params.createWidgetAppearanceSection()); return form; },
      ai: { description: "Instructor × local day utilisation heatmap. Map session-level instructor, local_day, booked, capacity, disrupted. Clicking a cell cross-filters the page." } },
    { ...baseDefinition, id: "recovery-metric", label: "Recovery metric", comp: RecoveryMetric, minSize: { width: 150, height: 70 }, defaultSize: { width: 240, height: 100 }, defaultState: { dataMapping: { rows: [{ id: "disruptions.id" }, { id: "disruptions.applied_revenue_kept" }] }, format: { style: { metric: "kept" } } },
      form: (params) => { const form = params.createDefaults({ dataMappingItems: [{ key: "rows", label: "Recovery / refund fields" }] }); form.items[1].items.push({ type: "section", key: "metric", label: "Metric", items: [{ type: "select", id: "format.style.metric", label: "Metric", items: [{ value: "kept", label: "Revenue kept" }, { value: "saved", label: "Saved rate" }, { value: "refunded", label: "Refunds issued" }], defaultValue: "kept" }] }); return form; },
      ai: { description: "Recovery KPI with explicit $0 or dash empty state. Include the row ID. Map applied_revenue_kept for kept, applied_saved and applied_affected for saved, kind and issued_refund for refunded." } },
  ],
  menu: [{ label: "Rebook", widgetIds: ["recovery-impact", "refund-receipts", "week-heatmap", "recovery-metric"] }, ...defaults.menu.map((group) => ({ ...group, widgetIds: [...group.widgetIds] }))],
  });
  const csv: AgWidgetToolbarItem = { type: "button", id: "export", label: "Export CSV", icon: "csv" };
  const png: AgWidgetToolbarItem = { type: "button", id: "download", label: "Download PNG", icon: "download" };
  // Setting toolbar definitions on the public config keeps the built-in handlers.
  // 3.0.0's overrides generic resolves to never for a registry containing custom types.
  return { ...configured, widgets: configured.widgets.map((widget) => {
    if (widget.id === "grid") return { ...widget, toolbar: ["duplicate" as const, "delete" as const, csv] };
    if (widget.id === "bar-chart-grouped" || widget.id === "column-chart-grouped") return { ...widget, toolbar: ["duplicate" as const, "delete" as const, csv, png] };
    return widget;
  }) };
};
