"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { PlanDetails, PublicPlan, ExecutionResult } from "@/lib/client/api";
import type { Placement, State } from "@/lib/domain/types";
import { disruptionLabel } from "@/lib/client/scheduler-mapping";
import { formatMoney, toCents } from "@/lib/domain/time";
import { recoveryOutcomes, summarizeRecovery, type RecoveryOutcome } from "../../lib/recovery/outcomes";
import type { summarizeOutbox } from "../../lib/choices/outbox";
import { planCovers } from "../../lib/recovery/covers";
import type { OwnerCover } from "../../lib/recovery/cover-pay";
import NextSteps from "./next-steps";

const BookingGrid = dynamic(() => import("./booking-grid"), { ssr: false, loading: () => <div className="booking-grid skeleton" role="status" aria-label="Loading booking actions" /> });

export function CoverRecord({ plan, state, links }: { plan: PublicPlan; state: State; links?: OwnerCover[] }) {
  const covers = planCovers(plan, state);
  if (!covers.length) return null;
  return <div className="cover-confirmations"><h3>Substitute confirmations</h3><ul>{covers.map((cover) => {
    const confirmation = plan.coverConfirmations?.find((item) => item.sessionId === cover.sessionId && item.instructorId === cover.instructorId);
    // The substitute's own answer on their cover link supersedes the owner's pre-approval record.
    const answered = links?.find((item) => item.planId === plan.id && item.sessionId === cover.sessionId && item.respondedBy === "instructor");
    if (answered) return <li key={cover.sessionId}>{cover.label} — {answered.status === "accepted" ? `Accepted by ${cover.instructor} on their cover link` : `Declined by ${cover.instructor}`}</li>;
    return <li key={cover.sessionId}>{cover.label} — {confirmation ? <>Confirmed by {confirmation.confirmedBy} at <time dateTime={confirmation.confirmedAt}>{new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(confirmation.confirmedAt))}</time></> : "Not yet confirmed"}</li>;
  })}</ul></div>;
}

export function ApprovalDialog({ unconfirmed, busy, onApprove, onClose }: { unconfirmed: ReturnType<typeof planCovers>; busy: boolean; onApprove: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal(); cancel.current?.focus();
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="approval-dialog" aria-labelledby="approval-title" aria-describedby="approval-help" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="approval-title">Approve this recovery?</h2><p id="approval-help">Approval applies this schedule and starts sandbox refunds.</p>
    {unconfirmed.length > 0 && <div className="warning"><h3>{unconfirmed.length} cover{unconfirmed.length === 1 ? "" : "s"} not yet confirmed</h3><ul>{unconfirmed.map((cover) => <li key={cover.sessionId}>{cover.label}</li>)}</ul><p>You can approve now and follow up with these instructors.</p></div>}
    <div className="button-row"><button ref={cancel} disabled={busy} onClick={onClose}>Keep reviewing</button><button className="primary" disabled={busy} onClick={onApprove}>Confirm approval and refund</button></div>
  </dialog>;
}

export function RefundResults({ results, state }: { results: ExecutionResult[]; state: State }) {
  if (!results.length) return null;
  return <section className="refund-results" aria-label="Refund progress"><h3>Refund results</h3>{results.map((result) => {
    const booking = state.bookings.find((item) => item.id === result.bookingId);
    const customer = state.customers.find((item) => item.id === booking?.customerId);
    return <div className="refund-row" key={result.bookingId}>
      <div><strong>{customer?.name ?? result.bookingId}</strong><span className={`result-status status-${result.status.toLowerCase()}`}>{result.status === "SIMULATED" ? "Simulated" : result.status === "NEEDS_REVIEW" ? "Needs review" : result.status.toLowerCase()}</span></div>
      {customer?.prefs.availabilityKnown === false && <small className="muted">availability not given</small>}
      {result.paypalId && <code>{result.paypalId}</code>}{result.error && <p className="error">{result.status === "NEEDS_REVIEW" ? result.error : ["REQUESTED", "UNKNOWN", "PENDING"].includes(result.status) ? "PayPal hasn't confirmed this refund yet. Retry checks its status before another attempt." : "This refund needs attention. Retry to reconcile with PayPal."}</p>}
    </div>;
  })}</section>;
}

export default function PlanPanel({ details, plan, state, busy, approving, results, outcomes, outboxSummary, coverLinks, customerPath, onPreview, approvalRequested, disruptionText, onUndo, onMove, onApprove, onDiscard, onMessages }: {
  details: PlanDetails; plan: PublicPlan; state: State; busy: boolean; results: ExecutionResult[];
  outcomes?: RecoveryOutcome[];
  outboxSummary?: ReturnType<typeof summarizeOutbox>;
  coverLinks?: OwnerCover[];
  customerPath?: string; onPreview?: (party: "customer" | "instructor") => void;
  approving?: boolean; approvalRequested?: boolean; disruptionText?: string; onUndo?: () => void; onMove?: (sessionId: string) => void; onApprove: (confirmedCoverSessionIds?: string[]) => void; onDiscard: () => void; onMessages: () => void;
}) {
  const totals = plan.totals;
  const money = (value: string) => formatMoney(value, state.studio.currency);
  const label = disruptionLabel(plan, state);
  const proposed = plan.status === "proposed";
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const wasProposed = useRef(proposed);
  const reviewKey = `${plan.id}:${plan.version ?? 1}`;
  const [coverSelection, setCoverSelection] = useState<{ key: string; ids: string[] }>({ key: "", ids: [] });
  const [approvalReview, setApprovalReview] = useState("");
  const covers = planCovers(plan, state);
  const confirmedIds = coverSelection.key === reviewKey ? coverSelection.ids : [];
  // A new plan replaces the button that requested it; keep keyboard users in place instead of on <body>.
  useEffect(() => {
    const doc = resultHeading.current?.ownerDocument;
    if (doc && (!doc.activeElement || doc.activeElement === doc.body)) resultHeading.current?.focus();
  }, [plan.id]);
  useEffect(() => {
    if (wasProposed.current && !proposed) resultHeading.current?.focus();
    wasProposed.current = proposed;
  }, [proposed]);
  const recovery = summarizeRecovery(outcomes ?? recoveryOutcomes(state, [{ ...plan, results }], []));
  const previous = plan.lastAdjustmentTotals;
  const refunds = previous ? totals.refunded - previous.refunded : 0;
  const revenue = previous ? toCents(totals.revenueKept) - toCents(previous.revenueKept) : 0;
  const placementLabel = (placement: Placement) => `${new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(placement.start))} · ${state.instructors.find((item) => item.id === placement.instructorId)?.name ?? "Instructor"}`;
  return <>
    <section className="phone-plan-context" aria-label="Disruption facts"><h2>What happened?</h2><p>{disruptionText || label.subject}</p><div className="understood-card"><p className="eyebrow">Understood</p><h3>{label.subject}</h3><p>{label.window}</p><p className="muted">{state.studio.timezone} · {totals.sessionsAffected} classes affected</p></div></section>
    <div className="section-label"><p className="eyebrow">{proposed ? "Recovery preview" : "Recovery record"}</p><span className="pill">{plan.status.replaceAll("_", " ")}</span></div>
    <h2 ref={resultHeading} tabIndex={-1}>{proposed ? details.explanation.headline : recovery.complete ? "Recovery complete" : "Recovery applied"}</h2>
    {!proposed && <p className="muted plan-context">{recovery.noReply ? `${recovery.noReplyCustomers} customer${recovery.noReplyCustomers === 1 ? " hasn't" : "s haven't"} replied` : "All customers replied"}. Confirmed bookings can still change through private links.</p>}
    {!proposed && outboxSummary && <p className="muted plan-context" role="status" aria-live="polite">{outboxSummary.sent} sent · {outboxSummary.replied} replied · {outboxSummary.waiting} waiting</p>}
    {plan.status === "executed" && onPreview && <NextSteps workspaceId={plan.workspaceId} summary={outboxSummary} covers={coverLinks?.filter((cover) => cover.planId === plan.id)} customerPath={customerPath} onMessages={onMessages} onPreview={onPreview} />}
    <p className="muted plan-context">{label.subject}<br />{label.window}</p>
    <p className="muted plan-context"><strong>Owner time saved (estimate)</strong><br />{plan.planningDurationMs !== undefined ? `Prepared in ${(plan.planningDurationMs / 1000).toFixed(1)} s · ` : ""}replaces about {plan.bookingActions.length} calls or messages once you share the links, plus {totals.refunded} manual refund{totals.refunded === 1 ? "" : "s"}.</p>
    <div className={`stats totals-updated${proposed ? "" : " recovery-outcomes"}`} key={`${plan.id}-${plan.version ?? 1}`} aria-live="polite" aria-atomic="true">
      {proposed ? <>
        <div><span>Kept</span><strong className="success">{totals.kept}</strong><small>same time</small></div>
        <div><span>Moved</span><strong className="primary-text">{totals.moved}</strong><small>new time</small></div>
        <div><span>Refunds planned</span><strong className="danger-text">{totals.refunded}</strong><small>bookings</small></div>
        <div className="money-stat"><span>Revenue kept / refunds</span><strong>{money(totals.revenueKept)}</strong><small>{money(totals.refundAmount)} in refunds</small></div>
      </> : <>
        <div><span>Kept or moved</span><strong className="success">{recovery.saved}</strong><small>in the new schedule - {recovery.kept} kept / {recovery.moved} moved</small></div>
        <div><span>Refunded</span><strong className="danger-text">{recovery.refunded}</strong><small>completed - {recovery.simulatedRefunded} simulated separately</small></div>
        <div><span>Pending</span><strong>{recovery.pending}</strong><small>refund requested / awaiting PayPal</small></div>
        <div><span>No reply yet</span><strong>{recovery.noReply}</strong><small>customer confirmation outstanding</small></div>
        <div className="money-stat"><span>Revenue kept / refunds</span><strong>{money(recovery.revenueKept.toFixed(2))}</strong><small>{money(recovery.completedRefundAmount.toFixed(2))} completed - {money(recovery.simulatedRefundAmount.toFixed(2))} simulated</small></div>
      </>}
    </div>
    {proposed && <div className="recovery-adjustments"><p className="muted">Review each changed session before approving:</p><ul role="list">{plan.sessionChanges.map((change) => {
      const session = state.sessions.find((item) => item.id === change.sessionId);
      const placement = change.after;
      const affected = new Set(state.bookings.filter((booking) => booking.sessionId === change.sessionId && plan.bookingActions.some((action) => action.bookingId === booking.id)).map((booking) => booking.customerId)).size;
      return <li key={change.sessionId}><strong>{session?.title ?? "Class"}</strong><span className="phone-change-detail">Originally: {placementLabel(change.before)}</span>{placement ? <>
        <span><span className="phone-change-detail">New: </span>{placementLabel(placement)}</span>
        {onMove && <button className="move-session-link" data-move-session={change.sessionId} disabled={busy} onClick={() => onMove(change.sessionId)} aria-label={`Move ${session?.title ?? "class"} to…`}>Move...</button>}
      </> : <span>Cancelled · refunds planned</span>}<span className="phone-change-detail">{affected} affected customer{affected === 1 ? "" : "s"}</span></li>;
    })}</ul>
      {covers.length > 0 && <fieldset className="cover-confirmations" disabled={busy}><legend>Confirm substitute arrangements</legend><p className="muted">Check only after you have asked the instructor and they agreed.</p>{covers.map((cover) => <label key={cover.sessionId}><input type="checkbox" checked={confirmedIds.includes(cover.sessionId)} onChange={(event) => setCoverSelection({ key: reviewKey, ids: event.target.checked ? [...confirmedIds, cover.sessionId] : confirmedIds.filter((id) => id !== cover.sessionId) })} />{cover.label} — Confirmed with {cover.instructor.split(" ")[0]}?</label>)}</fieldset>}
      {(previous || onUndo) && <div className="adjustment-change">
        {previous && <p role="status">Your change: {refunds === 0 ? "no change in refunds" : `${Math.abs(refunds)} ${refunds > 0 ? "more" : "fewer"} refund${Math.abs(refunds) === 1 ? "" : "s"}`}, {revenue < 0 ? "−" : revenue > 0 ? "+" : ""}{money((Math.abs(revenue) / 100).toFixed(2))} revenue kept (vs previous version).</p>}
        {onUndo && <button disabled={busy} onClick={onUndo} aria-label="Undo last adjustment">Undo</button>}
      </div>}
    </div>}
    <ul className="explanation">{details.explanation.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>
    {plan.warnings.length > 0 && <div className="warning"><strong>Please review</strong>{plan.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
    {proposed && <div className={`plan-actions ${approvalRequested ? "assistant-approval" : ""}`}>{approvalRequested && <p className="assistant-approval-banner" role="status">An assistant prepared this plan. Review and approve.</p>}<button id="judge-approve" className="primary" aria-describedby={approvalRequested ? "assistant-approval-help" : undefined} disabled={busy} onClick={() => setApprovalReview(reviewKey)}>{approving ? "Processing refunds…" : "Approve and refund"}</button><button disabled={busy} onClick={onDiscard}>Discard</button><p className="muted" id="assistant-approval-help">Approval applies this schedule and starts sandbox refunds.</p></div>}
    {proposed && approvalReview === reviewKey && <ApprovalDialog unconfirmed={covers.filter((cover) => !confirmedIds.includes(cover.sessionId))} busy={busy} onClose={() => setApprovalReview("")} onApprove={() => { setApprovalReview(""); onApprove(confirmedIds); }} />}
    {!proposed && <CoverRecord plan={plan} state={state} links={coverLinks} />}
    {plan.status === "executing" && <><p className="notice" role="status">Refunding with PayPal… {plan.refundProgress?.done ?? 0} of {plan.refundProgress?.total ?? totals.refunded} complete</p>{!busy && <button className="primary full-width" onClick={() => onApprove()}>Resume refund processing</button>}</>}
    {plan.status === "partially_failed" && <div className="warning" role="alert"><p>The schedule was updated, but PayPal sandbox hasn&apos;t confirmed every refund. Retry checks existing refunds before another attempt.</p><button className="primary full-width" disabled={busy} onClick={() => onApprove()}>{busy ? "Retrying refunds…" : "Retry"}</button></div>}
    {plan.status === "executed" && results.some((result) => result.status === "PENDING") && <button className="full-width" disabled={busy} onClick={() => onApprove()}>{busy ? "Checking refund status…" : "Check refund status"}</button>}
    <RefundResults results={results} state={state} />
    <button className="message-button" disabled={busy} onClick={onMessages}>{proposed ? "Preview customer messages" : "Customer messages and links"}</button>
    <BookingGrid plan={plan} state={state} />
  </>;
}
