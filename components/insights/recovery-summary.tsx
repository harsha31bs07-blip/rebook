import type { Insights } from "../../lib/insights/data";

/** Replies are independent of confirmed booking status; pending includes price-difference refunds. */
export default function RecoverySummary({ data }: { data: Insights }) {
  const applied = data.disruptions.filter((row) => row.status !== "proposed");
  const sum = (field: "applied_saved" | "refunded" | "pending" | "no_reply" | "simulated_refunded") => applied.reduce((total, row) => total + row[field], 0);
  return <section className="stats recovery-summary" aria-label="Current recovery outcomes">
    <div><span>Kept or moved</span><strong>{sum("applied_saved")}</strong><small>confirmed</small></div>
    <div><span>Refunded</span><strong>{sum("refunded")}</strong><small>completed</small></div>
    <div><span>Pending</span><strong>{sum("pending")}</strong><small>refund requested / awaiting PayPal</small></div>
    <div><span>No reply yet</span><strong>{sum("no_reply")}</strong><small>customer confirmation outstanding</small></div>
    <p className="muted">Confirmed bookings can still change through private links. Pending includes price differences for moved bookings. Simulated refunds: {sum("simulated_refunded")}.</p>
  </section>;
}
