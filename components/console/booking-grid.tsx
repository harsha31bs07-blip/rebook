"use client";

import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, enableDevValidations, themeQuartz, type ColDef, type GetRowIdParams, type ICellRendererParams } from "ag-grid-community";
import { entitlementLabel, entitlementPaymentLabel } from "../../lib/domain/entitlements";
import type { Plan, State } from "@/lib/domain/types";
import type { LedgerEvent } from "../../lib/store";
import { plannedPackBalances } from "../../lib/domain/pack-balances";

ModuleRegistry.registerModules([AllCommunityModule]);
if (process.env.NODE_ENV !== "production") enableDevValidations();

type ActionRow = { id: string; customer: string; class: string; action: string; reason: string; amount: number; entitlement?: string };
const theme = themeQuartz.withParams({
  accentColor: "var(--brand)", foregroundColor: "var(--ink)", backgroundColor: "var(--surface)", borderColor: "var(--border)",
  headerBackgroundColor: "var(--surface-2)", fontFamily: "var(--font-ui), Arial, sans-serif", fontSize: 12,
  wrapperBorderRadius: 10, rowHeight: 40, headerHeight: 36,
});
const rowId = ({ data }: GetRowIdParams<ActionRow>) => data.id;
const defaultColDef: ColDef<ActionRow> = { sortable: true, resizable: true };
function ActionCell({ value }: ICellRendererParams<ActionRow>) { return <span className={`action-pill action-${value}`}>{value}</span>; }
const columns: ColDef<ActionRow>[] = [
  { field: "customer", headerName: "Customer", width: 132 },
  { field: "class", headerName: "Class", width: 114 },
  { field: "action", headerName: "Action", width: 92, cellRenderer: ActionCell },
  { field: "reason", headerName: "Reason", width: 240, tooltipField: "reason" },
  { field: "amount", headerName: "Amount", width: 240, type: "numericColumn", valueFormatter: ({ value, data }) => data?.entitlement ?? `$${Number(value).toFixed(2)}` },
];

export default function BookingGrid({ plan, state, ledger }: { plan: Plan; state: State; ledger?: LedgerEvent[] }) {
  const [filter, setFilter] = useState("");
  const rows = useMemo<ActionRow[]>(() => {
    const balances = plannedPackBalances(state, ledger ?? [], plan);
    return plan.bookingActions.map((action) => {
      const booking = state.bookings.find((item) => item.id === action.bookingId);
      const customer = state.customers.find((item) => item.id === action.customerId);
      const balance = balances.get(action.bookingId);
      return { id: action.bookingId, customer: customer?.name ?? "Customer",
        class: state.sessions.find((item) => item.id === booking?.sessionId)?.title ?? "Cancelled class",
        action: action.action, reason: `${customer?.prefs.availabilityKnown === false ? "availability not given · " : ""}${action.reason}`, amount: Number(action.amount),
        entitlement: booking?.entitlement ? action.action === "refund" ? entitlementLabel(booking.entitlement, balance) : entitlementPaymentLabel(booking.entitlement, balance?.before) : undefined };
    });
  }, [plan, state, ledger]);
  return <section className="booking-section" aria-label="Booking actions">
    <div className="section-label"><h3>Booking actions</h3><span>{rows.length}</span></div>
    <label className="sr-only" htmlFor="booking-search">Filter booking actions</label>
    <input id="booking-search" type="search" placeholder="Search customers, classes, reasons…" value={filter} onChange={(event) => setFilter(event.target.value)} />
    <div className="booking-grid"><AgGridReact<ActionRow> theme={theme} rowData={rows} columnDefs={columns}
      onGridReady={({ api }) => api.setGridAriaProperty("label", "Booking actions")}
      defaultColDef={defaultColDef} getRowId={rowId} quickFilterText={filter} tooltipShowDelay={250} /></div>
  </section>;
}
