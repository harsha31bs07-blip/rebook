"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Interpretation, type PlanDetails } from "@/lib/client/api";
import { classColors, weekBounds, type RowMode } from "@/lib/client/scheduler-mapping";
import type { Plan, State } from "@/lib/domain/types";
import { useWorkspace } from "./use-workspace";
import DisruptionPanel from "./disruption-panel";
import PlanPanel from "./plan-panel";
import MessagesDrawer from "./messages-drawer";
import ConsoleHeader from "./console-header";
import ExpiredDemo from "./expired-demo";
import { useWebMcp } from "../../lib/webmcp/use-webmcp";
import { ownerTools, planSummary } from "../../lib/webmcp/tools";

const Schedule = dynamic(() => import("./schedule"), { ssr: false, loading: () => <ScheduleSkeleton /> });
function ScheduleSkeleton() {
  return <div className="schedule-skeleton" aria-label="Loading schedule"><div className="skeleton-header skeleton" />{Array.from({ length: 6 }, (_, i) => <div className="skeleton-row" key={i}><div className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>)}</div>;
}

export default function OwnerConsole({ id }: { id: string }) {
  const [busy, setBusy] = useState("");
  const { workspace, error: loadError, refresh, expired, bookingNotice } = useWorkspace(id, busy === "approve" || busy === "reset");
  const [text, setText] = useState("");
  const [interpretation, setInterpretation] = useState<Interpretation>();
  const [details, setDetails] = useState<PlanDetails>();
  const [basis, setBasis] = useState<State>();
  const [updatedPlan, setUpdatedPlan] = useState<Plan>();
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [mode, setMode] = useState<RowMode>("instructors");
  const [zoom, setZoom] = useState<"day" | "week">("week");
  const [day, setDay] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [ended, setEnded] = useState(false);
  const [approvalRequested, setApprovalRequested] = useState("");
  const actionInFlight = useRef(false);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 8000); return () => clearTimeout(timer); }, [toast]);

  async function run<T,>(action: string, operation: () => Promise<T>, propagate = false): Promise<T | undefined> {
    if (actionInFlight.current) { if (propagate) throw new Error("Another action is in progress. Try again when it finishes."); return; }
    actionInFlight.current = true;
    setBusy(action); setError("");
    try { return await operation(); }
    catch (cause) {
      if (cause instanceof ApiError && cause.code === "expired") setEnded(true);
      setError(cause instanceof Error ? cause.message : "Something went wrong. Please try again.");
      if (propagate) throw cause;
    }
    finally { actionInFlight.current = false; setBusy(""); }
  }
  const state = workspace?.state;
  const livePlan = workspace?.plans.find((item) => item.id === details?.plan.id);
  const plan = details && (livePlan ?? details.plan);
  const preview = details && plan?.status === "proposed";
  const timelineState = preview && basis ? basis : state;
  const results = plan?.results ?? [];
  const history = workspace?.plans.filter((item) => item.status !== "proposed").toReversed() ?? [];
  const ready = workspace?.status === "ready";
  const percent = workspace && workspace.progress.total ? Math.round(workspace.progress.done / workspace.progress.total * 100) : 0;

  function clearPlan() { setApprovalRequested(""); setDetails(undefined); setBasis(undefined); setInterpretation(undefined); setError(""); }
  async function interpretText(value: string, signal?: AbortSignal) {
    setText(value); setApprovalRequested("");
    const parsed = await api.interpret(id, value, signal);
    signal?.throwIfAborted();
    setInterpretation(parsed);
    return parsed;
  }
  async function previewPlan(parsed: Interpretation, signal?: AbortSignal) {
    if (!state) throw new Error("The studio is not ready.");
    const proposed = await api.plan(id, parsed.disruption, signal);
    const next = await api.details(id, proposed.id, signal);
    signal?.throwIfAborted();
    setApprovalRequested(""); setBasis({ ...state, sessions: next.sessions }); setDetails(next); setUpdatedPlan(undefined); setZoom("week"); await refresh();
    return planSummary(next.plan, state.studio.currency);
  }
  async function createPlan() {
    if (!interpretation || !state) return;
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
  async function approve() {
    if (!plan) return;
    await run("approve", async () => {
      const outcome = await api.approve(id, plan.id);
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

  useWebMcp(() => ready && state && !expired && !ended ? ownerTools({ state, plans: workspace.plans, currentPlan: plan, busy: Boolean(busy), report: reportDisruption, requestApproval }) : []);

  if (expired || ended) return <ExpiredDemo />;
  return <main className="console-app">
    {state?.bookings.some((booking) => booking.payment?.unknown) && <p className="error error-box" role="status">payment unknown (simulated fallback) — some bookings could not be verified with PayPal. No new capture will be attempted.</p>}
    <ConsoleHeader name={state?.studio.name} week={state ? weekBounds(state).label : undefined}><Link href={`/w/${id}/book`} target="_blank" rel="noopener noreferrer">Customer booking page</Link><Link href={`/w/${id}/dashboard`}>Dashboard</Link><button disabled={Boolean(busy) || !ready} onClick={() => setConfirmReset(!confirmReset)}>Reset demo</button></ConsoleHeader>
    {confirmReset && <div className="reset-confirm" role="group" aria-label="Confirm reset"><span>Start a fresh demo week? Existing sandbox transactions stay in the ledger.</span><button className="danger-button" onClick={() => void reset()}>Reset this demo</button><button onClick={() => setConfirmReset(false)}>Keep this week</button></div>}
    <div className="console-body">
      <section className="timeline-panel" aria-label="Studio schedule">
        <div className="timeline-heading"><div><p className="eyebrow">Your studio, in sync</p><h1>The week ahead</h1></div><span className={`schedule-state ${preview ? "preview-state" : ""}`}>{preview ? "Preview · awaiting approval" : ready ? "Schedule up to date" : "Getting ready"}</span></div>
        <div className="schedule-toolbar"><div className="row-controls"><span className="muted">Rows:</span><div className="segmented" aria-label="Schedule rows"><button aria-pressed={mode === "instructors"} onClick={() => setMode("instructors")}>Instructors</button><button aria-pressed={mode === "rooms"} onClick={() => setMode("rooms")}>Rooms</button></div></div><div className="zoom-controls">{zoom === "day" && <><button aria-label="Previous day" disabled={day === 0} onClick={() => setDay(day - 1)}>‹</button><span>{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day]}</span><button aria-label="Next day" disabled={day === 6} onClick={() => setDay(day + 1)}>›</button></>}<div className="segmented" aria-label="Schedule zoom"><button aria-pressed={zoom === "day"} onClick={() => setZoom("day")}>Day</button><button aria-pressed={zoom === "week"} onClick={() => setZoom("week")}>Week</button></div></div></div>
        {preview && <div className="preview-key"><span className="ghost-key">Original</span><span className="new-key">Recovery</span><span className="cancel-key">Cancelled</span><span>Arrows connect time moves</span></div>}
        <div className="schedule-canvas">
          {timelineState && ready ? <Schedule key={`${id}-${mode}-${zoom}-${day}`} state={timelineState} mode={mode} zoom={zoom} day={day} plan={preview ? plan : undefined} updatedPlan={updatedPlan} highlightedSessionId={bookingNotice?.sessionId} /> : <ScheduleSkeleton />}
          {(!workspace || !ready) && <div className="preparing-overlay"><div className="preparing-card"><span className="eyebrow">Setting the week in motion</span><h2>{workspace?.status === "failed" ? "We couldn’t prepare this demo" : "Preparing your studio"}</h2><p className="muted">{workspace?.status === "failed" ? workspace.preparationError || "Some sandbox payments could not be prepared. Open a fresh demo to try again." : "Creating bookings and preparing sandbox payments. This can take a minute."}</p>{workspace?.status === "failed" ? <Link className="primary button-link" href="/">Back to Rebook</Link> : <><progress max={100} value={percent} aria-label="Workspace preparation" /><span className="muted" role="status">{percent}% · {workspace?.progress.done ?? 0} of {workspace?.progress.total ?? "…"} bookings ready</span></>}{loadError && <p className="error" role="alert">{loadError}</p>}</div></div>}
        </div>
        <footer className="schedule-footer"><div className="class-legend">{Object.entries(classColors).map(([name, colors]) => <span key={name}><i style={{ backgroundColor: colors[0], borderColor: colors[1] }} />{name === "hiit" ? "HIIT" : name}</span>)}</div><span>{state?.studio.timezone ?? "Studio local time"} · 7am–9pm · Scroll to explore</span></footer>
      </section>
      <aside className="disruption-panel" aria-label="Recovery assistant" aria-busy={Boolean(busy)}>
        {ready && state ? <>
          {(error || loadError) && <p className="error error-box" role="alert">{error || loadError}</p>}
          {details && plan ? <><PlanPanel details={details} plan={plan} state={basis ?? state} busy={Boolean(busy)} results={results} approvalRequested={approvalRequested === plan.id} onApprove={() => void approve()} onDiscard={clearPlan} onMessages={() => setMessagesOpen(true)} />{plan.status !== "proposed" && <button className="full-width" onClick={clearPlan} disabled={Boolean(busy)}>Plan another recovery</button>}</>
            : <DisruptionPanel state={state} text={text} setText={setText} interpretation={interpretation} busy={Boolean(busy)} onInterpret={(value) => run("interpret", () => interpretText(value))} onReport={reportDisruption} onEdit={() => setInterpretation(undefined)} onPlan={createPlan} />}
          {history.length > 0 && <section className="history"><h3>History <span>{history.length}</span></h3>{history.map((item) => <button key={item.id} disabled={Boolean(busy)} onClick={() => void run("history", async () => { const next = await api.details(id, item.id); setDetails(next); setBasis({ ...state, sessions: next.sessions }); })}><strong>{item.totals.sessionsAffected} sessions · {item.totals.refunded} refunds</strong><span>{item.status.replaceAll("_", " ")} · {new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, hour: "numeric", minute: "2-digit" }).format(new Date(item.createdAt))}</span></button>)}</section>}
        </> : <><p className="eyebrow">Recovery assistant</p><h2>A better plan<br />is on its way.</h2><p className="muted">Your schedule and recovery tools will be ready as soon as setup finishes.</p><div className="panel-skeleton skeleton" /><div className="panel-skeleton skeleton" /></>}
      </aside>
    </div>
    <div className="sr-only" role="status" aria-live="polite">{busy === "approve" ? `Processing refunds. ${results.length} results received.` : busy ? "Working on your request." : ""}</div>
    {toast && <div className="toast" role="status">{toast}<button aria-label="Dismiss notification" onClick={() => setToast("")}>×</button></div>}
    {bookingNotice && !toast && <div className="toast" role="status">{bookingNotice.message}</div>}
    {messagesOpen && details && <MessagesDrawer messages={details.messages} onClose={() => setMessagesOpen(false)} />}
  </main>;
}
