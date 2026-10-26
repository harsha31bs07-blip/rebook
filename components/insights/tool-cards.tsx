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

export const recoveryToolDisplay = {
  get_disruptions: { label: cardLabel("disruptions"), detail: RecoveryToolCard },
  get_refund_receipts: { label: cardLabel("receipts"), detail: RecoveryToolCard },
} satisfies Record<string, AgAiToolDisplay>;
