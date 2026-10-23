"use client";

import { useEffect, useState } from "react";
import { createWidgets, type AgWidgetDefinition } from "ag-studio-react";
import type { AgDefaultRegistry, AgStudioApi, AgWidgetDataFormat, AgWidgetFieldReference, AgWidgetParams, AgWidgetsConfig } from "ag-studio";
import { receiptFields, recoveryFields } from "@/lib/insights/report";

type CustomFormat = AgWidgetDataFormat<{ planId?: string }>;
export type RecoveryWidget = { type: "recovery-impact"; dataMapping: { rows: AgWidgetFieldReference[] }; format?: CustomFormat };
export type ReceiptsWidget = { type: "refund-receipts"; dataMapping: { rows: AgWidgetFieldReference[] }; format?: CustomFormat };
export interface StudioRegistry extends Omit<AgDefaultRegistry, "widgets"> {
  widgets: readonly (AgDefaultRegistry["widgets"][number] | AgWidgetDefinition<"recovery-impact", RecoveryWidget> | AgWidgetDefinition<"refund-receipts", ReceiptsWidget>)[];
}
type Row = Record<string, unknown>;
const money = (value: unknown) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(value) || 0);

function useWidgetRows(params: AgWidgetParams<RecoveryWidget | ReceiptsWidget>) {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const { dataMapping, widgetApi } = params;
  useEffect(() => {
    let current = true;
    const fields = dataMapping.rows ?? [];
    if (!fields.length) { widgetApi.setDisplayState("incompleteDataMapping"); return; }
    widgetApi.setDisplayState("loading", { prominent: false });
    widgetApi.getData({ fields }).then(({ results }) => {
      if (!current) return;
      const normalized = results.rows.map((row) => Object.fromEntries(fields.map((field) => [field.fieldId.split(".").at(-1)!, row[field.key]])));
      setRows(normalized); setError(""); widgetApi.setDisplayState("displayed");
    }).catch(() => { if (current) { setError("Could not load widget data. Try refreshing the report."); widgetApi.setDisplayState("displayed"); } });
    return () => { current = false; };
  }, [params, dataMapping, widgetApi]);
  return { rows, error };
}

function RecoveryImpact(params: AgWidgetParams<RecoveryWidget>) {
  const { rows, error } = useWidgetRows(params);
  const sorted = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
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
  return <div className="recovery-impact">
    <label>Disruption<select aria-label="Selected disruption" value={String(selected.id)} onChange={(event) => select(event.target.value)}>{sorted.map((row) => <option key={String(row.id)} value={String(row.id)}>{String(row.subject)} · {String(row.window)}</option>)}</select></label>
    <div className="impact-headline"><strong>{money(selected.revenue_kept)} kept <span>vs {money(selected.refund_amount)} refunded</span></strong><span className="pill success-pill">{affected ? Math.round((kept + moved) / affected * 100) : 0}% saved</span></div>
    <div className="impact-bar" role="img" aria-label={`${kept} kept, ${moved} moved, ${refunded} refunded`}>
      {[kept, moved, refunded].map((count, index) => count > 0 && <span className={`impact-segment impact-${index}`} key={index} style={{ flex: count }} />)}
    </div>
    <div className="impact-legend"><span><i className="impact-0" />{kept} Kept</span><span><i className="impact-1" />{moved} Moved</span><span><i className="impact-2" />{refunded} Refunded</span></div>
    <p className="muted">{String(selected.status) === "proposed" ? "Proposed recovery · forecast" : "Applied recovery"} · {String(selected.sessions_affected)} classes affected</p>
  </div>;
}

function RefundReceipts(params: AgWidgetParams<ReceiptsWidget>) {
  const { rows, error } = useWidgetRows(params);
  const refunds = rows.filter((row) => row.kind === "refund" && (!params.format?.style?.planId || row.plan_id === params.format.style.planId)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!refunds.length) return <div className="insight-empty"><strong>No refund receipts yet</strong><p>Approved refunds will appear here with their PayPal reference and latest status.</p></div>;
  return <div className="receipt-list" aria-label="Refund receipts">{refunds.map((row) => {
    const status = String(row.status);
    const label = status === "SIMULATED" ? "Simulated" : status === "COMPLETED" ? "Completed" : ["PENDING", "REQUESTED"].includes(status) ? "Pending" : status.toLowerCase().replaceAll("_", " ");
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
        style: s.object({ planId: s.string({ description: "Disruption plan ID, or omit for latest/all receipts." }).optional() }).optional(),
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

export const customWidgets = (defaults: AgWidgetsConfig<AgDefaultRegistry>) => createWidgets<StudioRegistry>({
  additionalTypes: [
    { ...baseDefinition, id: "recovery-impact", label: "Recovery impact", comp: RecoveryImpact, defaultState: { dataMapping: { rows: recoveryFields } }, ai: { description: "Stacked kept/moved/refunded bookings, revenue retained and saved rate for a selected disruption." } },
    { ...baseDefinition, id: "refund-receipts", label: "Refund receipts", comp: RefundReceipts, defaultState: { dataMapping: { rows: receiptFields } }, ai: { description: "Refund receipts with PayPal IDs, customers, amounts and latest payment status." } },
  ],
  menu: [{ label: "Rebook", widgetIds: ["recovery-impact", "refund-receipts"] }, ...defaults.menu.map((group) => ({ ...group, widgetIds: [...group.widgetIds] }))],
});
