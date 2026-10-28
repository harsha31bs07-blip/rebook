"use client";

import type { AgAiToolDetailParams, AgAiToolLabelParams } from "ag-studio";
import type { AgAiToolDisplay } from "ag-studio-react";
import styles from "./insights.module.css";
import { titleCase } from "@/lib/insights/formatting";

export function toolRows(result: AgAiToolLabelParams["result"], key: "disruptions" | "receipts"): Record<string, unknown>[] {
  if (!result?.success || !result.data || typeof result.data !== "object") return [];
  const rows = (result.data as Record<string, unknown>)[key];
  return Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object") : [];
}

function cardLabel(key: "disruptions" | "receipts") {
  return ({ result, status }: AgAiToolLabelParams) => {
    const noun = key === "disruptions" ? "disruption" : "refund receipt";
    if (status === "cancelled") return { text: `Reading ${noun}s`, pill: "Stopped" };
    if (!result) return { text: `Reading ${noun}s` };
    if (!result.success) return { text: `Could not read ${noun}s` };
    const count = toolRows(result, key).length;
    return { text: `${key === "disruptions" ? "Looked up" : "Read"} ${count} ${noun}${count === 1 ? "" : "s"}` };
  };
}

function RecoveryToolCard({ result }: AgAiToolDetailParams) {
  if (!result) return <div className={styles.toolCard}>Reading workspace records…</div>;
  if (!result.success) return <div className={styles.toolCard}>Records could not be read. Please try again.</div>;
  const disruptions = toolRows(result, "disruptions"), receipts = toolRows(result, "receipts");
  const rows = disruptions.length ? disruptions : receipts;
  return <div className={styles.toolCard}>
    {!rows.length ? <p>No matching records in this workspace.</p> : rows.slice(0, 8).map((row, index) => <p key={index}>
      <strong>{String(row.customer ?? row.disruption ?? "Recovery record")}</strong><br />
      {row.customer ? `${String(row.class)} · $${Number(row.amountUSD).toFixed(2)} · ${titleCase(String(row.status))} · ${String(row.payment)}` : `${Number(row.bookingsKept) + Number(row.bookingsMoved)} bookings saved · $${Number(row.plannedRefundsUSD).toFixed(2)} in planned refunds · $${Number(row.completedRefundsUSD).toFixed(2)} in completed refunds · ${titleCase(String(row.status))}`}
    </p>)}
    {rows.length > 8 && <p>{rows.length - 8} more records read.</p>}
  </div>;
}

function AnalystToolCard({ result }: AgAiToolDetailParams) {
  if (!result) return <div className={styles.toolCard}>Reading workspace records…</div>;
  if (!result.success) return <div className={styles.toolCard}>The request could not be completed. Please try again.</div>;
  const data = result.data as Record<string, unknown> | undefined;
  if (!data) return <div className={styles.toolCard}>No matching records.</div>;
  const rows = (Array.isArray(data.rows) ? data.rows : Array.isArray(data.disruptions) ? data.disruptions : []) as Record<string, unknown>[];
  const usd = (amount: unknown) => `$${Number(amount ?? 0).toFixed(2)}`;
  return <div className={styles.toolCard}>
    {data.chart ? <p><strong>{String(data.chart)}</strong></p> : null}
    {typeof data.kept === "number" && <p><strong>{data.kept} kept · {Number(data.moved)} moved · {Number(data.refunded)} refunded</strong><br />
      {Number(data.simulatedRefunded)} simulated refunds · {Number(data.pending)} pending · {Number(data.noReply)} without reply<br />
      {usd(data.revenueKept)} kept · {usd(data.completedRefundAmount)} refunded · {usd(data.simulatedRefundAmount)} simulated</p>}
    {!data.chart && rows.length === 0 && typeof data.kept !== "number" && <p>No matching records in this workspace.</p>}
    {rows.slice(0, 8).map((row, index) => <p key={index}>
      <strong>{String(row.label ?? row.disruption ?? row.class)}</strong><br />
      {"bookedUSD" in row ? `${row.bookings} bookings · ${usd(row.bookedUSD)} booked · ${usd(row.keptUSD)} kept`
        : "completedUSD" in row ? `${row.requests} requests · ${usd(row.completedUSD)} completed · ${usd(row.simulatedUSD)} simulated · ${usd(row.pendingUSD)} pending · ${usd(row.failedUSD)} failed`
        : "coveringInstructor" in row ? `${row.coveringInstructor} covered ${row.originalInstructor} · ${row.day} at ${row.time} · ${titleCase(String(row.status))}`
        : `${titleCase(String(row.status))} · ${row.kept} kept · ${row.moved} moved · ${row.refunded} refunded · ${row.simulatedRefunded} simulated refunds · ${row.pending} pending · ${row.noReply} without reply · ${usd(row.revenueKept)} kept · ${usd(row.completedRefundAmount)} refunded · ${usd(row.simulatedRefundAmount)} simulated · ${usd(row.pendingRefundUSD)} pending · ${usd(row.failedRefundUSD)} failed · ${usd(row.plannedRefundUSD)} forecast`}
    </p>)}
    {rows.length > 8 && <p>{rows.length - 8} more records read.</p>}
    {data.asOf ? <p>Data as of <time dateTime={String(data.asOfIso ?? data.asOf)}>{String(data.asOf)}</time>{data.timezone ? ` · ${data.timezone}` : ""}</p> : null}
    {data.note ? <p>{String(data.note)}</p> : null}
  </div>;
}

function analystDisplay(noun: string) {
  return { label: ({ result, status }) => ({ text: status === "cancelled" ? noun : !result ? `Reading ${noun}` : result.success ? noun : `Could not complete ${noun}`, ...(status === "cancelled" ? { pill: "Stopped" } : {}) }), detail: AnalystToolCard } satisfies AgAiToolDisplay;
}

export const recoveryToolDisplay = {
  get_recovery_summary: analystDisplay("Recovery summary"),
  get_refund_breakdown: analystDisplay("Refund breakdown"),
  get_revenue_breakdown: analystDisplay("Revenue breakdown"),
  get_cover_summary: analystDisplay("Instructor cover"),
  add_preset_chart: analystDisplay("Preset chart"),
  get_disruptions: { label: cardLabel("disruptions"), detail: RecoveryToolCard },
  get_refund_receipts: { label: cardLabel("receipts"), detail: RecoveryToolCard },
} satisfies Record<string, AgAiToolDisplay>;
