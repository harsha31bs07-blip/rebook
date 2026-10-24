"use client";

import { useEffect, useRef, useState } from "react";
import type { Plan, State } from "../../lib/domain/types";
import { addLocalDays, localParts, zonedTimeToUtc } from "../../lib/domain/time";
import { weekBounds } from "../../lib/client/scheduler-mapping";
import { checkAdjustment, type OwnerAdjustment } from "../../lib/solver/adjust";
import { moveDayLabel, moveTimeOptions } from "../../lib/client/move-options";

export default function MoveToPopover({ state, plan, sessionId, busy, onAdjust, onClose }: {
  state: State; plan: Plan; sessionId: string; busy: boolean;
  onAdjust: (input: OwnerAdjustment) => Promise<void>; onClose: () => void;
}) {
  const change = plan.sessionChanges.find((item) => item.sessionId === sessionId)!;
  const after = change.after!;
  const local = localParts(after.start, state.studio.timezone);
  const clock = `${String(Math.floor(local.minutesOfDay / 60)).padStart(2, "0")}:${String(Math.floor(local.minutesOfDay % 60)).padStart(2, "0")}`;
  const [date, setDate] = useState(local.dateKey);
  const [time, setTime] = useState(clock);
  const [instructorId, setInstructorId] = useState(after.instructorId);
  const [roomId, setRoomId] = useState(after.roomId);
  const [error, setError] = useState("");
  const session = state.sessions.find((item) => item.id === sessionId)!;
  const options = moveTimeOptions(state, session, date);
  const selectedTime = options.some((item) => item.value === time) ? time : options[0]?.value ?? "";
  const dialog = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal(); first.current?.focus();
    return () => {
      element?.close();
      // Timeline event DOM can be replaced when the placement is saved.
      const trigger = previous?.isConnected ? previous : document.querySelector<HTMLElement>(`[data-move-session="${CSS.escape(sessionId)}"]`);
      trigger?.focus();
    };
  }, [sessionId]);
  return <dialog ref={dialog} className="move-to-popover" aria-labelledby="move-to-title" aria-describedby="move-to-help" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (busy || !selectedTime) return;
      const input = { sessionId, start: zonedTimeToUtc(date, selectedTime, state.studio.timezone), instructorId, roomId };
      const checked = checkAdjustment(state, plan, input);
      if (!checked.valid) { setError(checked.message); return; }
      setError("");
      void onAdjust(input).then(onClose, (cause: unknown) => setError(cause instanceof Error ? cause.message : "This placement is unavailable."));
    }}>
      <h2 id="move-to-title">Move {session.title} to…</h2><p id="move-to-help" className="muted">Times are in {state.studio.timezone}. Only starts within studio opening hours are listed.</p>
      <fieldset disabled={busy}>
        <label>Day<select ref={first} value={date} onChange={(event) => setDate(event.target.value)}>{Array.from({ length: 7 }, (_, index) => {
          const key = addLocalDays(weekBounds(state).startKey, index);
          return <option key={key} value={key}>{moveDayLabel(key)}</option>;
        })}</select></label>
        <label>Time<select value={selectedTime} disabled={!options.length} onChange={(event) => setTime(event.target.value)}>{options.length ? options.map(({ value, label }) => <option key={value} value={value}>{label}</option>) : <option value="">No times available</option>}</select></label>
        <label>Instructor<select value={instructorId} onChange={(event) => setInstructorId(event.target.value)}>{state.instructors.map((item) => <option key={item.id} value={item.id} disabled={!item.skills.includes(session.classType)}>{item.name}</option>)}</select></label>
        <label>Room<select value={roomId} onChange={(event) => setRoomId(event.target.value)}>{state.rooms.map((item) => <option key={item.id} value={item.id} disabled={!item.supports.includes(session.classType)}>{item.name}</option>)}</select></label>
      </fieldset>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="plan-actions"><button type="submit" className="primary" disabled={busy || !selectedTime}>{busy ? "Checking placement…" : "Move class"}</button><button type="button" onClick={onClose}>Cancel</button></div>
    </form>
  </dialog>;
}
