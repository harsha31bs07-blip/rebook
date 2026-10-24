"use client";

import dynamic from "next/dynamic";
import type { PlanDetails, PublicPlan, ExecutionResult } from "@/lib/client/api";
import type { State } from "@/lib/domain/types";
import { disruptionLabel } from "@/lib/client/scheduler-mapping";
import { formatMoney } from "@/lib/domain/time";

const BookingGrid = dynamic(() => import("./booking-grid"), { ssr: false, loading: () => <div className="booking-grid skeleton" aria-label="Loading booking actions" /> });

export function RefundResults({ results, state }: { results: ExecutionResult[]; state: State }) {
  if (!results.length) return null;
  return <section className="refund-results" aria-label="Refund progress"><h3>Refund results</h3>{results.map((result) => {
    const booking = state.bookings.find((item) => item.id === result.bookingId);
    const customer = state.customers.find((item) => item.id === booking?.customerId);
    return <div className="refund-row" key={result.bookingId}>
      <div><strong>{customer?.name ?? result.bookingId}</strong><span className={`result-status status-${result.status.toLowerCase()}`}>{result.status === "SIMULATED" ? "Simulated" : result.status.toLowerCase()}</span></div>
      {result.paypalId && <code>{result.paypalId}</code>}{result.error && <p className="error">{result.error}</p>}
    </div>;
  })}</section>;
}

export default function PlanPanel({ details, plan, state, busy, results, approvalRequested, onApprove, onDiscard, onMessages }: {
  details: PlanDetails; plan: PublicPlan; state: State; busy: boolean; results: ExecutionResult[];
  approvalRequested?: boolean; onApprove: () => void; onDiscard: () => void; onMessages: () => void;
}) {
  const totals = plan.totals;
  const money = (value: string) => formatMoney(value, state.studio.currency);
  const label = disruptionLabel(plan, state);
  const proposed = plan.status === "proposed";
  return <>
    <div className="section-label"><p className="eyebrow">{proposed ? "Recovery preview" : "Recovery record"}</p><span className="pill">{plan.status.replaceAll("_", " ")}</span></div>
    <h2>{plan.status === "executed" ? results.some((result) => ["PENDING", "REQUESTED"].includes(result.status)) ? "Recovery applied · refunds pending" : "Recovery complete" : details.explanation.headline}</h2>
    {plan.status === "executed" && <p className="muted plan-context">{totals.kept + totals.moved} bookings saved · {money(totals.revenueKept)} kept · {totals.refunded} refund{totals.refunded === 1 ? "" : "s"}{results.some((result) => result.status === "PENDING") ? " (some pending)" : " processed"}.</p>}
    <p className="muted plan-context">{label.subject}<br />{label.window}</p>
    <div className="stats">
      <div><span>Kept</span><strong className="success">{totals.kept}</strong><small>same time</small></div>
      <div><span>Moved</span><strong className="primary-text">{totals.moved}</strong><small>new time</small></div>
      <div><span>{proposed ? "Refunds planned" : "Refunds completed"}</span><strong className="danger-text">{proposed ? totals.refunded : results.filter((result) => result.status === "COMPLETED").length}</strong><small>{proposed ? "bookings" : `${results.filter((result) => ["PENDING", "REQUESTED"].includes(result.status)).length} pending · ${results.filter((result) => result.status === "SIMULATED").length} simulated`}</small></div>
      <div className="money-stat"><span>Revenue kept / refunds</span><strong>{money(totals.revenueKept)}</strong><small>{money(totals.refundAmount)} in refunds</small></div>
    </div>
    <ul className="explanation">{details.explanation.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>
    {plan.warnings.length > 0 && <div className="warning"><strong>Please review</strong>{plan.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
    {proposed && <div className={`plan-actions ${approvalRequested ? "assistant-approval" : ""}`}>{approvalRequested && <p className="assistant-approval-banner" role="status">An assistant prepared this plan. Review and approve.</p>}<button className="primary" aria-describedby={approvalRequested ? "assistant-approval-help" : undefined} disabled={busy} onClick={onApprove}>{busy ? "Processing refunds…" : "Approve and refund"}</button><button disabled={busy} onClick={onDiscard}>Discard</button><p className="muted" id="assistant-approval-help">Approval applies this schedule and starts sandbox refunds.</p></div>}
    {plan.status === "executing" && <><p className="notice" role="status">Applying recovery and processing sandbox refunds…</p>{!busy && <button className="primary full-width" onClick={onApprove}>Resume refund processing</button>}</>}
    {plan.status === "partially_failed" && <><p className="warning">The schedule was updated, but some refunds need attention. Review the results below.</p><button className="primary full-width" disabled={busy} onClick={onApprove}>{busy ? "Retrying refunds…" : "Retry refunds"}</button></>}
    <button className="message-button" disabled={busy} onClick={onMessages}>Preview customer messages</button>
    <RefundResults results={results} state={state} />
    <BookingGrid plan={plan} state={state} />
  </>;
}
