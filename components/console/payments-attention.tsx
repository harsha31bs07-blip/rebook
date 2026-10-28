"use client";

import { useState } from "react";
import { api } from "../../lib/client/api";
import type { PaymentAttention } from "../../lib/recovery/payment-attention";

export default function PaymentsAttention({ workspaceId, payments, onUpdated }: {
  workspaceId: string; payments?: PaymentAttention[]; onUpdated: () => void;
}) {
  const [checking, setChecking] = useState("");
  const [notice, setNotice] = useState("");
  const [absent, setAbsent] = useState("");
  if (!payments?.length) return null;
  async function check(requestId: string) {
    setChecking(requestId); setNotice(""); setAbsent("");
    try {
      const result = await api.checkRefund(workspaceId, requestId);
      if (result.kind === "absent") setAbsent(requestId);
      setNotice(result.kind === "absent" ? "PayPal shows no refund for this capture. It is safe to retry."
        : result.kind === "unknown" ? "PayPal could not confirm the outcome. The amount stays reserved; check the capture in PayPal before taking further action."
          : "PayPal status checked.");
      onUpdated();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to check PayPal."); }
    finally { setChecking(""); }
  }
  async function retry(requestId: string) {
    setChecking(requestId); setNotice("");
    try {
      const result = await api.retryRefund(workspaceId, requestId);
      setAbsent("");
      setNotice(["COMPLETED", "SIMULATED"].includes(result.status) ? "Refund completed." : result.status === "PENDING" ? "Refund sent. PayPal is still confirming it." : "PayPal did not complete the retry. The amount stays reserved.");
      onUpdated();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to retry the refund."); }
    finally { setChecking(""); }
  }
  return <section className="refund-results" aria-label="Payments needing attention"><h3>Payments needing attention</h3>
    {payments.map((payment) => <div className="refund-row" key={payment.requestId}>
      <div><strong>{payment.customer} · ${payment.amount}</strong><span className="result-status">{payment.status === "NEEDS_REVIEW" ? "Needs review" : payment.status.toLowerCase()}</span></div>
      <p className="muted"><time dateTime={payment.since}>{payment.ageMinutes < 1 ? "Just now" : `${payment.ageMinutes} min ago`}</time></p>
      <p>{payment.status === "NEEDS_REVIEW" ? "PayPal may already have issued this refund. Automatic retry is paused to avoid a duplicate. Check with PayPal before retrying."
        : ["FAILED", "CANCELLED"].includes(payment.status) ? "This refund needs attention. Check with PayPal before retrying."
          : "PayPal has not confirmed this refund yet. Its amount remains reserved."}</p>
      <button disabled={!!checking} onClick={() => void check(payment.requestId)}>{checking === payment.requestId ? "Checking PayPal…" : "Check with PayPal"}</button>
      {absent === payment.requestId && <button className="primary" disabled={!!checking} onClick={() => void retry(payment.requestId)}>Retry refund</button>}
    </div>)}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
