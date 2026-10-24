"use client";

import { useEffect, useRef, useState } from "react";
import type { Plan, State } from "../../lib/domain/types";
import { addLocalDays, localParts, zonedTimeToUtc } from "../../lib/domain/time";
import { weekBounds } from "../../lib/client/scheduler-mapping";
import { checkAdjustment, type OwnerAdjustment } from "../../lib/solver/adjust";

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
  const dialog = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal(); first.current?.focus();
    return () => { element?.close(); previous?.focus(); };
  }, []);
  const session = state.sessions.find((item) => item.id === sessionId)!;
  return <dialog ref={dialog} className="move-to-popover" aria-labelledby="move-to-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (busy) return;
      const input = { sessionId, start: zonedTimeToUtc(date, time, state.studio.timezone), instructorId, roomId };
      const checked = checkAdjustment(state, plan, input);
      if (!checked.valid) { setError(checked.message); return; }
      setError("");
      void onAdjust(input).then(onClose, (cause: unknown) => setError(cause instanceof Error ? cause.message : "This placement is unavailable."));
    }}>
      <h3 id="move-to-title">Move {session.title} to…</h3><p className="muted">Times are in {state.studio.timezone}.</p>
      <fieldset disabled={busy}>
        <label>Day<select ref={first} value={date} onChange={(event) => setDate(event.target.value)}>{Array.from({ length: 7 }, (_, index) => {
          const key = addLocalDays(weekBounds(state).startKey, index);
          return <option key={key} value={key}>{key}</option>;
        })}</select></label>
        <label>Time<select value={time} onChange={(event) => setTime(event.target.value)}>{[...new Set([clock, ...Array.from({ length: 96 }, (_, index) => `${String(Math.floor(index / 4)).padStart(2, "0")}:${String(index % 4 * 15).padStart(2, "0")}`)])].sort().map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>Instructor<select value={instructorId} onChange={(event) => setInstructorId(event.target.value)}>{state.instructors.map((item) => <option key={item.id} value={item.id} disabled={!item.skills.includes(session.classType)}>{item.name}</option>)}</select></label>
        <label>Room<select value={roomId} onChange={(event) => setRoomId(event.target.value)}>{state.rooms.map((item) => <option key={item.id} value={item.id} disabled={!item.supports.includes(session.classType)}>{item.name}</option>)}</select></label>
      </fieldset>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="plan-actions"><button type="submit" className="primary" disabled={busy}>{busy ? "Checking placement…" : "Move class"}</button><button type="button" onClick={onClose} disabled={busy}>Cancel</button></div>
    </form>
  </dialog>;
}
