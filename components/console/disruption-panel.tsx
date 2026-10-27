"use client";

import { useEffect, useRef } from "react";
import type { Interpretation } from "@/lib/client/api";
import type { State } from "@/lib/domain/types";
import { disruptionLabel, interpretationSource } from "@/lib/client/scheduler-mapping";
import { overlaps, localParts } from "../../lib/domain/time";

const examples = ["Maya has the flu and can't teach Monday", "The Cycle Lab AC is broken Wednesday afternoon", "Studio closed Saturday morning for a burst pipe"];

export default function DisruptionPanel({ state, text, setText, interpretation, onInterpret, onReport, onEdit, onPlan, busy }: {
  state: State; text: string; setText: (text: string) => void; interpretation?: Interpretation;
  onInterpret: (text: string) => Promise<unknown>; onReport: (text: string) => Promise<unknown>; onEdit: () => void; onPlan: () => void; busy: boolean;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const question = useRef<HTMLHeadingElement>(null);
  const understoodHeading = useRef<HTMLHeadingElement>(null);
  const clarification = interpretation?.kind === "clarify" ? interpretation : undefined;
  const understood = interpretation?.kind !== "clarify" ? interpretation : undefined;
  useEffect(() => { if (clarification) question.current?.focus(); }, [clarification]);
  useEffect(() => { if (understood) understoodHeading.current?.focus(); }, [understood]);
  const label = understood && disruptionLabel(understood, state);
  const affected = understood ? state.sessions.filter((session) => {
    const disruption = understood.disruption;
    return overlaps(session.start, session.end, disruption.from, disruption.to) &&
      (disruption.kind === "closure" || (disruption.kind === "instructor_unavailable" ? session.instructorId === disruption.instructorId : session.roomId === disruption.roomId));
  }) : [];
  const allDay = understood && localParts(understood.disruption.from, state.studio.timezone).minutesOfDay === 0 && localParts(understood.disruption.to, state.studio.timezone).minutesOfDay === 0;
  const severalDays = understood && localParts(understood.disruption.from, state.studio.timezone).dateKey !== localParts(new Date(Date.parse(understood.disruption.to) - 1).toISOString(), state.studio.timezone).dateKey;
  return <>
    <p className="eyebrow disruption-intro">A little change of plans</p><h2><span className="desktop-disruption-title">Let’s get your week<br />back on track.</span><span className="phone-disruption-title">What happened?</span></h2>
    <p className="muted disruption-intro">Tell us what changed. We’ll find the best way to take care of everyone.</p>
    {clarification && <div className="understood-card">
      <h3 ref={question} id="clarification-question" tabIndex={-1}>{clarification.question}</h3>
      <div role="group" aria-labelledby="clarification-question" className="examples">
        {clarification.suggestions.map((suggestion) => <button key={suggestion} type="button" disabled={busy} onClick={() => { setText(suggestion); void onInterpret(suggestion); }}>{suggestion}</button>)}
      </div>
      <p className="muted">Choose a suggestion or edit your description below.</p>
    </div>}
    {!understood ? <form {...(!busy ? { toolname: "preview_disruption", tooldescription: "Prepare a disruption recovery preview on the owner's timeline. No schedule changes or refunds occur until the owner reviews and clicks Approve and refund.", toolautosubmit: "" } : {})} onSubmit={(event) => {
      event.preventDefault();
      const value = (event.currentTarget.elements.namedItem("text") as HTMLTextAreaElement).value;
      const native = event.nativeEvent as SubmitEvent & { agentInvoked?: boolean; respondWith?: (result: Promise<unknown>) => void };
      if (native.agentInvoked) {
        const result = onReport(value);
        if (native.respondWith) native.respondWith(result);
        else void result.catch(() => {});
      } else void onInterpret(value);
    }}>
      <label className="field-label disruption-label" htmlFor="disruption">What happened?</label>
      <textarea ref={textarea} id="disruption" name="text" {...{ toolparamdescription: "What changed: instructor absence, unavailable room, or studio closure, including the local day and time." }} maxLength={500} rows={4} placeholder="An instructor is out, a room is unavailable…" value={text} onChange={(event) => setText(event.target.value)} disabled={busy} required />
      <div className="input-caption"><span>Use your own words</span><span>{text.length}/500</span></div>
      <button className="primary full-width" type="submit" disabled={busy || !text.trim()}>{busy ? "Understanding disruption…" : "Understand disruption"}</button>
      <p className="try-label">Or try an example</p><div className="examples" id="judge-examples">{examples.map((example) => <button type="button" key={example} disabled={busy} onClick={() => { setText(example); textarea.current?.focus(); }}>{example}<span aria-hidden="true">↗</span></button>)}</div>
    </form> : <div className="understood-card">
      <div className="section-label"><span className="eyebrow">Understood</span><span className="pill" tabIndex={understood.aiBusy ? 0 : undefined} title={understood.aiBusy ? "AI is busy or unavailable, so the local rules parser interpreted this disruption. Review it below; planning and refunds still use deterministic checks." : undefined}>{understood.aiBusy ? "Rules (AI busy)" : interpretationSource(understood.source, understood.model)}</span></div>
      <h3 ref={understoodHeading} tabIndex={-1}>{label?.subject}</h3><p>{label?.window}</p><p className="muted">{state.studio.timezone}</p>
      <p><strong>Classes affected:</strong> {affected.length ? affected.map((session) => `${session.title} at ${new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(session.start))}`).join("; ") : "None scheduled in this window"}.</p>
      {allDay && !/\ball day\b/i.test(text) && <p className="muted">{severalDays ? "Assumed all day throughout this window." : `Assumed all day ${new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, weekday: "long" }).format(new Date(understood.disruption.from))}.`}</p>}
      {understood.notes.length > 0 && <ul>{understood.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
      <div className="button-row"><button id="judge-plan" className="primary" onClick={onPlan} disabled={busy}>{busy ? "Finding recovery…" : "Plan recovery"}</button><button onClick={onEdit} disabled={busy}>Edit</button></div>
    </div>}
    <div className="how-it-works"><h3>A calmer way to handle change</h3><ol><li>Describe the disruption.</li><li>Review every change on your timeline.</li><li>Approve the plan. Refunds are handled.</li></ol><p>You stay in control. Nothing changes until you approve.</p></div>
  </>;
}
