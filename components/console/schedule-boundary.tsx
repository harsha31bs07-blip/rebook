"use client";

import { Component, useEffect, useRef, type ReactNode } from "react";
import type { Plan, State } from "../../lib/domain/types";
import { mapSchedule } from "../../lib/client/scheduler-mapping";

export function ScheduleFallback({ state, plan, highlightedSessionId, onMove }: { state: State; plan?: Plan; highlightedSessionId?: string; onMove?: (sessionId: string) => void }) {
  const data = mapSchedule(state, "instructors", plan);
  const list = useRef<HTMLElement>(null);
  useEffect(() => { list.current?.querySelector(".new-booking-highlight")?.scrollIntoView({ block: "nearest", behavior: "instant" }); }, [highlightedSessionId, plan]);
  return <section ref={list} className="schedule-fallback" aria-label="Accessible week schedule">
    <p role="status">The interactive timeline is unavailable in this browser. Your week and recovery plan are listed below.</p>
    <ul>{[...data.events].sort((a, b) => Date.parse(String(a.startDate)) - Date.parse(String(b.startDate))).map((event) => {
      const info = data.details[String(event.id)];
      const change = plan?.sessionChanges.find((item) => item.after && `${item.sessionId}-new` === event.id);
      return <li key={String(event.id)} className={event.id === (plan ? `${highlightedSessionId}-new` : highlightedSessionId) ? "new-booking-highlight" : undefined}><strong>{info.title} · {info.status}</strong>
        <p>{new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, weekday: "long", month: "short", day: "numeric" }).format(new Date(String(event.startDate)))} · {info.time}</p>
        <p>{state.instructors.find((item) => item.id === event.resourceId)?.name} · {info.room} · {info.occupancy} {info.badge}</p>
        {change && onMove && <button data-move-session={change.sessionId} onClick={() => onMove(change.sessionId)}>Move {info.title} to…</button>}
      </li>;
    })}</ul>
    {data.resourceTimeRanges.length + data.timeRanges.length > 0 && <><h2>Unavailability</h2><ul>{[...data.resourceTimeRanges, ...data.timeRanges].map((range) =>
      <li key={String(range.id)}>{range.name} · {new Date(String(range.startDate)).toLocaleString("en-US", { timeZone: state.studio.timezone })} – {new Date(String(range.endDate)).toLocaleString("en-US", { timeZone: state.studio.timezone })}</li>)}</ul></>}
  </section>;
}

export class ScheduleBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
