"use client";

import { useState } from "react";
import { api } from "../../lib/client/api";
import type { PaymentAttention } from "../../lib/recovery/payment-attention";

export default function PaymentsAttention({ workspaceId, payments, onUpdated }: {
  workspaceId: string; payments?: PaymentAttention[]; onUpdated: () => void;
}) {
  const [checking, setChecking] = useState("");
  const [notice, setNotice] = useState("");
  if (!payments?.length) return null;
  async function check(requestId: string) {
    setChecking(requestId); setNotice("");
    try {
      const result = await api.checkRefund(workspaceId, requestId);
      setNotice(result.kind === "absent" ? "PayPal shows no refund for this capture. You can retry the approved refund from its recovery record."
        : result.kind === "unknown" ? "PayPal could not confirm the outcome. The amount stays reserved; check the capture in PayPal before taking further action."
          : "PayPal status checked.");
      onUpdated();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to check PayPal."); }
    finally { setChecking(""); }
  }
  return <section className="refund-results" aria-label="Payments needing attention"><h3>Payments needing attention</h3>
    {payments.map((payment) => <div className="refund-row" key={payment.requestId}>
      <div><strong>{payment.customer} · ${payment.amount}</strong><span className="result-status">{payment.status === "NEEDS_REVIEW" ? "Needs review" : payment.status.toLowerCase()}</span></div>
      <p className="muted"><time dateTime={payment.since}>{payment.ageMinutes < 1 ? "Just now" : `${payment.ageMinutes} min ago`}</time></p>
      <p>{payment.status === "NEEDS_REVIEW" ? "PayPal may already have issued this refund. Automatic retry is paused to avoid a duplicate. Check with PayPal before retrying."
        : ["FAILED", "CANCELLED"].includes(payment.status) ? "This refund needs attention. Check with PayPal before retrying from its recovery record."
          : "PayPal has not confirmed this refund yet. Its amount remains reserved."}</p>
      <button disabled={!!checking} onClick={() => void check(payment.requestId)}>{checking === payment.requestId ? "Checking PayPal…" : "Check with PayPal"}</button>
    </div>)}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
