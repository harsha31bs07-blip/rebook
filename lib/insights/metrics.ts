const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 }).format(value);

/** Detail rows include their IDs so Studio does not collapse equal-valued records. */
export function recoveryMetric(rows: Record<string, unknown>[], metric?: string) {
  const records = metric === "refunded" ? rows.filter((row) => row.kind === "refund") : rows;
  const total = (field: string) => records.reduce((sum, row) => sum + Math.round((Number(row[field]) || 0) * 100), 0) / 100;
  const affected = total("applied_affected");
  const value = metric === "saved" ? affected ? `${Math.round(total("applied_saved") / affected * 100)}%` : "-"
    : money(total(metric === "kept" ? "applied_revenue_kept" : "issued_refund"));
  const visits = total("visits_returned");
  return { value, caption: !records.length ? "No disruptions yet" : metric === "refunded" ? `Includes simulated payments${visits ? ` · ${visits} visits returned` : ""}` : "Applied recoveries" };
}
