"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Interpretation } from "@/lib/client/api";
import { classColors, weekBounds, type RowMode } from "@/lib/client/scheduler-mapping";
import type { Plan } from "@/lib/domain/types";
import { useWorkspace } from "./use-workspace";
import DisruptionPanel from "./disruption-panel";
import PlanPanel from "./plan-panel";
import { ScheduleBoundary, ScheduleFallback } from "./schedule-boundary";
import MoveToPopover from "./move-to-popover";
import { draftCustomerMessages } from "../../lib/ai/messages";
import { formatMoney, localParts } from "../../lib/domain/time";
import type { OwnerAdjustment } from "../../lib/solver/adjust";
import MessagesDrawer from "./messages-drawer";
import { summarizeOutbox } from "../../lib/choices/outbox";
import ConsoleHeader from "./console-header";
import ExpiredDemo from "./expired-demo";
import { useWebMcp } from "../../lib/webmcp/use-webmcp";
import { ownerTools, planSummary } from "../../lib/webmcp/tools";
import JudgeHint from "./judge-hint";
import { usePlanPreview } from "./use-plan-preview";
import ScheduleAgenda from "./schedule-agenda";
import { useScheduleView } from "./use-schedule-view";

const Schedule = dynamic(() => import("./schedule"), { ssr: false, loading: () => <ScheduleSkeleton /> });
function ScheduleSkeleton() {
  return <div className="schedule-skeleton" aria-label="Loading schedule"><div className="skeleton-header skeleton" />{Array.from({ length: 6 }, (_, i) => <div className="skeleton-row" key={i}><div className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>)}</div>;
}

export default function OwnerConsole({ id }: { id: string }) {
  const [moveSession, setMoveSession] = useState<string>();
  const [movedSession, setMovedSession] = useState<{ id: string; version: number }>();
  const [busy, setBusy] = useState("");
  const { workspace, error: loadError, refresh, expired, bookingNotice, startupMessage } = useWorkspace(id, ["approve", "reconcile", "reset"].includes(busy));
  const [text, setText] = useState("");
  const [interpretation, setInterpretation] = useState<Interpretation>();
  const { details, setDetails, basis, setBasis, restoreError, restore } = usePlanPreview(id, workspace);
  const [updatedPlan, setUpdatedPlan] = useState<Plan>();
  const [error, setError] = useState("");
  const [retryRefunds, setRetryRefunds] = useState(false);
  const [toast, setToast] = useState("");
  const { phone, view, setView } = useScheduleView();
  const [mode, setMode] = useState<RowMode>("instructors");
  const [zoom, setZoom] = useState<"day" | "week">("week");
  const [day, setDay] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [ended, setEnded] = useState(false);
  const [approvalRequested, setApprovalRequested] = useState("");
  const actionInFlight = useRef(false);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 8000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (!movedSession) return; const timer = setTimeout(() => setMovedSession(undefined), 7500); return () => clearTimeout(timer); }, [movedSession]);

  async function run<T,>(action: string, operation: () => Promise<T>, propagate = false): Promise<T | undefined> {
    if (actionInFlight.current) { if (propagate) throw new Error("Another action is in progress. Try again when it finishes."); return; }
    actionInFlight.current = true;
    setBusy(action); setError(""); setRetryRefunds(false);
    try { return await operation(); }
    catch (cause) {
      if (cause instanceof ApiError && cause.code === "expired") setEnded(true);
      const paymentAction = (action === "approve" || action === "reconcile") && (!(cause instanceof ApiError) || cause.status >= 500 || [408, 429].includes(cause.status));
      setRetryRefunds(paymentAction);
      setError(paymentAction ? "PayPal sandbox couldn't confirm every refund. Retry to check recorded payments before any further refund attempt."
        : cause instanceof ApiError && cause.status >= 500 ? "The studio couldn't complete that request. Please retry."
          : cause instanceof Error ? cause.message : "Something went wrong. Please try again.");
      if (propagate) throw cause;
    }
    finally { actionInFlight.current = false; setBusy(""); }
  }
  const state = workspace?.state;
  const livePlan = workspace?.plans.find((item) => item.id === details?.plan.id);
  const plan = details && (livePlan && (livePlan.version ?? 1) >= (details.plan.version ?? 1) ? livePlan : details.plan);
  const preview = details && plan?.status === "proposed";
  const timelineState = preview && basis ? basis : state;
  const results = plan?.results ?? [];
  const history = workspace?.plans.filter((item) => item.status !== "proposed").toReversed() ?? [];
  const ready = workspace?.status === "ready";
  const percent = workspace && workspace.progress.total ? Math.round(workspace.progress.done / workspace.progress.total * 100) : 0;

  function clearPlan() { setMoveSession(undefined); setMovedSession(undefined); setApprovalRequested(""); setDetails(undefined); setBasis(undefined); setInterpretation(undefined); setError(""); }
  async function interpretText(value: string, signal?: AbortSignal) {
    setText(value); setApprovalRequested(""); setDetails(undefined);
    const parsed = await api.interpret(id, value, signal);
    signal?.throwIfAborted();
    setInterpretation(parsed);
    return parsed;
  }
  async function previewPlan(parsed: Interpretation, signal?: AbortSignal) {
    if (parsed.kind === "clarify") return parsed;
    if (!state) throw new Error("The studio is not ready.");
    const proposed = await api.plan(id, parsed.disruption, signal);
    const next = await api.details(id, proposed.id, signal);
    signal?.throwIfAborted();
    setApprovalRequested(""); setBasis({ ...state, sessions: next.sessions }); setDetails(next); setUpdatedPlan(undefined); setZoom("week"); await refresh();
    setToast("Recovery plan ready. Review the changes before approving.");
    return planSummary(next.plan, state.studio.currency);
  }
  async function createPlan() {
    if (!interpretation || interpretation.kind === "clarify" || !state) return;
    await run("plan", () => previewPlan(interpretation));
  }
  async function reportDisruption(value: string, signal?: AbortSignal) {
    return run("plan", async () => previewPlan(await interpretText(value, signal), signal), true);
  }
  async function requestApproval(planId: string, signal: AbortSignal) {
    return run("review", async () => {
      const next = await api.details(id, planId, signal);
      signal.throwIfAborted();
      if (next.plan.status !== "proposed") throw new Error("Only a proposed plan can be reviewed for approval.");
      if (!state) throw new Error("The studio is not ready.");
      setDetails(next); setBasis({ ...state, sessions: next.sessions }); setUpdatedPlan(undefined); setZoom("week");
      setApprovalRequested(planId);
      return { ...planSummary(next.plan, state.studio.currency), approval: "awaiting_owner_click", message: "An assistant prepared this plan. Review and approve." };
    }, true);
  }
  async function adjust(input: OwnerAdjustment | { undo: true }) {
    if (!plan || !preview) throw new Error("Only a recovery preview can be adjusted.");
    await run("adjust", async () => {
      const adjusted = await api.adjust(id, plan.id, input, plan.version ?? 1);
      const totals = adjusted.totals;
      const currentState = basis ?? state!;
      const sessionId = "undo" in input ? plan.lastAdjustment?.sessionId : input.sessionId;
      const placement = adjusted.sessionChanges.find((item) => item.sessionId === sessionId)?.after;
      if (sessionId && placement) {
        setMovedSession({ id: sessionId, version: adjusted.version ?? 1 });
        const dateKey = localParts(placement.start, currentState.studio.timezone).dateKey;
        if (zoom === "day") setDay(Math.round((Date.parse(dateKey) - Date.parse(weekBounds(currentState).startKey)) / 86400000));
      }
      setToast("undo" in input ? "Last adjustment undone. Review the restored placement and totals." : "Class moved. Review the updated placement and totals.");
      setDetails((previous) => previous ? { ...previous, plan: adjusted,
        messages: draftCustomerMessages(adjusted, currentState),
        explanation: { headline: "Your adjusted recovery plan is ready", source: "template", bullets: [
          `${totals.kept} bookings stay at their original time; ${totals.moved} move to a new time.`,
          `${totals.refunded} refunds total ${formatMoney(totals.refundAmount, currentState.studio.currency)}; ${formatMoney(totals.revenueKept, currentState.studio.currency)} in revenue stays with your studio.`,
        ] },
      } : previous);
      // The adjustment is already saved. A polling failure must not reject an accepted drop.
      await refresh().catch(() => setError("Adjustment saved. The workspace refresh failed; updates will retry shortly."));
    }, true);
  }
  async function approve() {
    if (!plan) return;
    await run(plan.status === "executed" ? "reconcile" : "approve", async () => {
      const outcome = await api.approve(id, plan.id, plan.version ?? 1);
      setUpdatedPlan(outcome.plan);
      setDetails((previous) => previous ? { ...previous, plan: outcome.plan } : previous); await refresh();
      const completed = outcome.results.filter((item) => item.status === "COMPLETED").length;
      const simulated = outcome.results.filter((item) => item.status === "SIMULATED").length;
      const outstanding = outcome.results.length - completed - simulated;
      setToast(completed ? `${completed} refund${completed === 1 ? "" : "s"} completed on PayPal (sandbox)${outstanding ? ` · ${outstanding} need review` : ""}${simulated ? ` · ${simulated} simulated` : ""}`
        : simulated ? `Schedule updated · ${simulated} simulated refunds${outstanding ? ` · ${outstanding} need review` : ""}`
          : outstanding ? "Schedule updated · review the refund results" : "Recovery approved. Your schedule is up to date.");
    });
  }
  async function reset() {
    setConfirmReset(false);
    await run("reset", async () => { await api.reset(id); clearPlan(); setUpdatedPlan(undefined); setText(""); await refresh(); setToast("Demo reset. Your new week is ready."); });
  }

  async function discard() {
    if (!plan || plan.status !== "proposed") return;
    await run("discard", async () => { await api.discard(id, plan.id); clearPlan(); await refresh(); });
  }
  function focusControl(selector: string) {
    const control = document.querySelector<HTMLElement>(selector);
    control?.scrollIntoView({ block: "center" }); control?.focus();
  }
  function tourStep(step: "example" | "plan" | "move" | "approve" | "messages") {
    if (step === "example") {
      if (details) { setToast("Discard the preview or finish this recovery before picking another example."); return; }
      if (interpretation) setInterpretation(undefined);
      requestAnimationFrame(() => focusControl("#judge-examples button"));
    } else if (step === "plan") {
      focusControl(interpretation && interpretation.kind !== "clarify" ? "#judge-plan" : "#disruption");
      if (!interpretation) setToast("Pick an example, then choose Understand disruption to unlock Plan recovery.");
    } else if (step === "move") focusControl(".move-session-link");
    else if (step === "approve") focusControl("#judge-approve");
    else setMessagesOpen(true);
  }

  useWebMcp(() => ready && state && !expired && !ended ? ownerTools({ state, plans: workspace.plans, currentPlan: plan, busy: Boolean(busy), report: reportDisruption, requestApproval }) : []);

  const schedulePanel = <section className={`timeline-panel ${view === "list" ? "agenda-view" : "timeline-view"}`} aria-label="Studio schedule">
        <div className="timeline-heading"><div><p className="eyebrow">Your studio, in sync</p>{phone ? <h2>The week ahead</h2> : <h1>The week ahead</h1>}</div><span className={`schedule-state ${preview ? "preview-state" : ""}`}>{preview ? "Preview · awaiting approval" : ready ? "Schedule up to date" : "Getting ready"}</span></div>
        <div className="schedule-toolbar"><div className="segmented" role="group" aria-label="Schedule view"><button aria-pressed={view === "timeline"} onClick={() => setView("timeline")}>Timeline</button><button aria-pressed={view === "list"} onClick={() => setView("list")}>List</button></div><div className="row-controls"><span className="muted">Rows:</span><div className="segmented" aria-label="Schedule rows"><button aria-pressed={mode === "instructors"} onClick={() => setMode("instructors")}>Instructors</button><button aria-pressed={mode === "rooms"} onClick={() => setMode("rooms")}>Rooms</button></div></div><div className="zoom-controls">{zoom === "day" && <><button aria-label="Previous day" disabled={day === 0} onClick={() => setDay(day - 1)}>‹</button><span>{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day]}</span><button aria-label="Next day" disabled={day === 6} onClick={() => setDay(day + 1)}>›</button></>}<div className="segmented" aria-label="Schedule zoom"><button aria-pressed={zoom === "day"} onClick={() => setZoom("day")}>Day</button><button aria-pressed={zoom === "week"} onClick={() => setZoom("week")}>Week</button></div></div></div>
        {preview && view === "timeline" && <div className="preview-key"><span className="ghost-key">Original</span><span className="new-key">Recovery</span><span className="cancel-key">Cancelled</span><span>Drag a recovery block, use Move, or focus it and press Enter / Space</span></div>}
        <div className="schedule-canvas">
          {timelineState && ready ? view === "list" ? <ScheduleAgenda state={timelineState} plan={preview ? plan : undefined} updatedPlan={updatedPlan} zoom={zoom} day={day} highlightedSessionId={movedSession?.id ?? bookingNotice?.sessionId} onMove={preview && !busy ? setMoveSession : undefined} /> : <ScheduleBoundary key={`${id}-${mode}-${zoom}-${day}`} fallback={<ScheduleFallback zoom={zoom} day={day} updatedPlan={updatedPlan} state={timelineState} plan={preview ? plan : undefined} highlightedSessionId={movedSession?.id} onMove={preview && !busy ? setMoveSession : undefined} />}><Schedule state={timelineState} mode={mode} zoom={zoom} day={day} plan={preview ? plan : undefined} updatedPlan={updatedPlan} highlightedSessionId={movedSession?.id ?? bookingNotice?.sessionId} busy={Boolean(busy)} onAdjust={preview ? adjust : undefined} onMove={setMoveSession} /></ScheduleBoundary> : <ScheduleSkeleton />}
          {(!workspace || !ready) && <div className="preparing-overlay"><div className="preparing-card"><span className="eyebrow">Setting the week in motion</span><h2 role="status">{workspace?.status === "failed" ? "We couldn’t prepare this demo" : startupMessage}</h2><p className="muted">{workspace?.status === "failed" ? "Some sandbox payments could not be prepared. Open a fresh demo to try again." : "Creating bookings and preparing sandbox payments. This can take a minute."}</p>{workspace?.status === "failed" ? <Link className="primary button-link" href="/">Back to Rebook</Link> : <><progress max={100} value={percent} aria-label="Workspace preparation" /><span className="muted" role="status">{percent}% · {workspace?.progress.done ?? 0} of {workspace?.progress.total ?? "…"} bookings ready</span></>}{loadError && <p className="error" role="alert">{loadError}</p>}</div></div>}
          {preview && plan && timelineState && moveSession && <MoveToPopover key={moveSession} state={timelineState} plan={plan} sessionId={moveSession} busy={Boolean(busy)} onAdjust={adjust} onClose={() => setMoveSession(undefined)} />}
        </div>
        <footer className="schedule-footer"><div className="class-legend">{Object.entries(classColors).map(([name, colors]) => <span key={name}><i style={{ backgroundColor: colors[0], borderColor: colors[1] }} />{name === "hiit" ? "HIIT" : name}</span>)}</div><span>{state?.studio.timezone ?? "Studio local time"} · 7am–9pm · Scroll to explore</span></footer>
      </section>;
  const recoveryPanel = <aside className="disruption-panel" aria-label="Recovery assistant" aria-busy={Boolean(busy)}>
        <JudgeHint id={id} ready={ready && !busy} preview={Boolean(preview) && !busy} hasPlan={Boolean(plan) && !busy} onStep={tourStep} />
        {ready && state ? <>
          {(error || loadError) && (retryRefunds ? <div className="error error-box" role="alert">{error || loadError}<button disabled={Boolean(busy)} onClick={() => void approve()}>Retry</button></div> : <p className="error error-box" role="alert">{error || loadError}</p>)}
          {restoreError && <div className="warning" role="alert">{restoreError}<button disabled={Boolean(busy)} onClick={() => void restore()}>Retry</button></div>}
          {details && plan ? <><PlanPanel details={details} plan={plan} disruptionText={text} state={basis ?? state} outboxSummary={workspace.customerChoices?.outbox ? summarizeOutbox(workspace.customerChoices.outbox.filter((row) => row.planId === plan.id)) : undefined} outcomes={workspace.plans.some((item) => item.id === plan.id && item.status !== "proposed") ? workspace.customerChoices?.outcomes?.filter((item) => item.plan_id === plan.id) : undefined} busy={Boolean(busy)} approving={busy === "approve"} results={results} approvalRequested={approvalRequested === plan.id} onUndo={plan.lastAdjustment ? () => void adjust({ undo: true }).catch(() => {}) : undefined} onMove={setMoveSession} onApprove={() => void approve()} onDiscard={() => void discard()} onMessages={() => setMessagesOpen(true)} />{plan.status !== "proposed" && <button className="full-width" onClick={clearPlan} disabled={Boolean(busy)}>Plan another recovery</button>}</>
            : <DisruptionPanel state={state} text={text} setText={setText} interpretation={interpretation} busy={Boolean(busy)} onInterpret={(value) => run("interpret", () => interpretText(value))} onReport={reportDisruption} onEdit={() => setInterpretation(undefined)} onPlan={createPlan} />}
          {history.length > 0 && <section className="history"><h3>History <span>{history.length}</span></h3>{history.map((item) => <button key={item.id} disabled={Boolean(busy)} onClick={() => void run("history", async () => { const next = await api.details(id, item.id); setDetails(next); setBasis({ ...state, sessions: next.sessions }); })}><strong>{item.totals.sessionsAffected} sessions · {item.totals.refunded} refunds</strong><span>{item.status.replaceAll("_", " ")} · {new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, hour: "numeric", minute: "2-digit" }).format(new Date(item.createdAt))}</span></button>)}</section>}
          {(workspace.customerChoices?.links.length ?? 0) > 0 && <section className="customer-replies" aria-labelledby="replies-title"><div className="replies-heading"><h3 id="replies-title">Replies</h3><span className="muted">Updates live</span></div><ul aria-live="polite">{workspace.customerChoices?.replies.length ? workspace.customerChoices.replies.map((reply) => <li key={reply.id}><p>{reply.text}</p><time dateTime={reply.at}>{new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, hour: "numeric", minute: "2-digit" }).format(new Date(reply.at))}</time></li>) : <li className="muted">Waiting for customers. Open a private link from Customer messages to try a reply.</li>}</ul></section>}
        </> : <><p className="eyebrow">Recovery assistant</p><h2>A better plan<br />is on its way.</h2><p className="muted">Your schedule and recovery tools will be ready as soon as setup finishes.</p><div className="panel-skeleton skeleton" /><div className="panel-skeleton skeleton" /></>}
      </aside>;

  if (expired || ended) return <ExpiredDemo />;
  return <main id="main-content" tabIndex={-1} className="console-app">
    {state?.bookings.some((booking) => booking.payment?.unknown) && <p className="error error-box" role="status">payment unknown (simulated fallback) — some bookings could not be verified with PayPal. No new capture will be attempted.</p>}
    <ConsoleHeader workspaceId={id} name={state?.studio.name} week={state ? weekBounds(state).label : undefined}><Link href={`/w/${id}/book`} target="_blank" rel="noopener noreferrer">Customer booking page</Link><Link href={`/w/${id}/dashboard`}>Dashboard</Link><button disabled={Boolean(busy) || !ready} onClick={() => setConfirmReset(!confirmReset)}>Reset demo</button></ConsoleHeader>
    {confirmReset && <div className="reset-confirm" role="group" aria-label="Confirm reset"><span>Start a fresh demo week? Existing sandbox transactions stay in the ledger.</span><button className="danger-button" onClick={() => void reset()}>Reset this demo</button><button onClick={() => setConfirmReset(false)}>Keep this week</button></div>}
    <div className="console-body">
      {phone && <h1 className="sr-only">Studio recovery</h1>}
      {phone ? <>{recoveryPanel}{schedulePanel}</> : <>{schedulePanel}{recoveryPanel}</>}
    </div>
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{busy === "approve" ? `Processing refunds. ${results.length} results received.` : busy === "reconcile" ? "Checking refund status." : busy ? "Working on your request." : toast || (plan ? plan.status === "proposed" ? "Recovery plan ready. Review the changes before approving." : `${results.filter((result) => result.status === "COMPLETED").length} refunds completed. ${results.filter((result) => ["PENDING", "REQUESTED"].includes(result.status)).length} refunds pending.` : "")}</div>
    {toast && <div className="toast">{toast}<button aria-label="Dismiss notification" onClick={() => setToast("")}>×</button></div>}
    {bookingNotice && !toast && <div className="toast" role="status">{bookingNotice.message}</div>}
    {messagesOpen && details && <MessagesDrawer workspaceId={id} messages={details.messages} links={workspace?.customerChoices?.links.filter((link) => link.planId === details.plan.id)} outbox={details.plan.status !== "proposed" ? workspace?.customerChoices?.outbox?.filter((row) => row.planId === details.plan.id) : undefined} onUpdated={() => { void refresh().catch(() => setError("Outbox saved. The workspace refresh failed; updates will retry shortly.")); }} onClose={() => setMessagesOpen(false)} />}
  </main>;
}
