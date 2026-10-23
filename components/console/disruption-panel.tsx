"use client";

import { useRef } from "react";
import type { Interpretation } from "@/lib/client/api";
import type { State } from "@/lib/domain/types";
import { disruptionLabel } from "@/lib/client/scheduler-mapping";

const examples = ["Maya has the flu and can't teach Monday", "The Cycle Lab AC is broken Wednesday afternoon", "Studio closed Saturday morning for a burst pipe"];

export default function DisruptionPanel({ state, text, setText, interpretation, onInterpret, onEdit, onPlan, busy }: {
  state: State; text: string; setText: (text: string) => void; interpretation?: Interpretation;
  onInterpret: () => void; onEdit: () => void; onPlan: () => void; busy: boolean;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const label = interpretation && disruptionLabel(interpretation, state);
  return <>
    <p className="eyebrow">A little change of plans</p><h2>Let’s get your week<br />back on track.</h2>
    <p className="muted">Tell us what changed. We’ll find the best way to take care of everyone.</p>
    {!interpretation ? <form onSubmit={(event) => { event.preventDefault(); onInterpret(); }}>
      <label className="field-label" htmlFor="disruption">What happened?</label>
      <textarea ref={textarea} id="disruption" maxLength={500} rows={4} placeholder="An instructor is out, a room is unavailable…" value={text} onChange={(event) => setText(event.target.value)} disabled={busy} required />
      <div className="input-caption"><span>Use your own words</span><span>{text.length}/500</span></div>
      <button className="primary full-width" type="submit" disabled={busy || !text.trim()}>{busy ? "Understanding disruption…" : "Understand disruption"}</button>
      <p className="try-label">Or try an example</p><div className="examples">{examples.map((example) => <button type="button" key={example} disabled={busy} onClick={() => { setText(example); textarea.current?.focus(); }}>{example}<span aria-hidden="true">↗</span></button>)}</div>
    </form> : <div className="understood-card">
      <div className="section-label"><span className="eyebrow">Understood</span><span className="pill">{interpretation.source === "gemini" ? `Gemini ${interpretation.model ?? ""}` : "Rules"}</span></div>
      <h3>{label?.subject}</h3><p>{label?.window}</p><p className="muted">{state.studio.timezone} · {Math.round(interpretation.confidence * 100)}% confidence</p>
      {interpretation.notes.length > 0 && <ul>{interpretation.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
      <div className="button-row"><button className="primary" onClick={onPlan} disabled={busy}>{busy ? "Finding recovery…" : "Plan recovery"}</button><button onClick={onEdit} disabled={busy}>Edit</button></div>
    </div>}
    <div className="how-it-works"><h3>A calmer way to handle change</h3><ol><li>Describe the disruption.</li><li>Review every change on your timeline.</li><li>Approve the plan. Refunds are handled.</li></ol><p>You stay in control. Nothing changes until you approve.</p></div>
  </>;
}
