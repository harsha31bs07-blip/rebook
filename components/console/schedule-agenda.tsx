"use client";

import { useEffect, useRef } from "react";
import type { Plan, State } from "../../lib/domain/types";
import { mapSchedule, scheduleRange } from "../../lib/client/scheduler-mapping";
import { localParts } from "../../lib/domain/time";

export type AgendaProps = { state: State; plan?: Plan; updatedPlan?: Plan; highlightedSessionId?: string;
  zoom?: "day" | "week"; day?: number; onMove?: (sessionId: string) => void };

export default function ScheduleAgenda({ state, plan, updatedPlan, highlightedSessionId, zoom = "week", day = 0, onMove }: AgendaProps) {
  const data = mapSchedule(state, "instructors", plan, updatedPlan);
  const range = scheduleRange(state, zoom, day);
  const groups = new Map<string, typeof data.events>();
  for (const event of [...data.events].sort((a, b) => Date.parse(String(a.startDate)) - Date.parse(String(b.startDate)))) {
    const key = localParts(String(event.startDate), state.studio.timezone).dateKey;
    if (key < range.startKey || key >= range.endKey) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(event);
  }
  const list = useRef<HTMLElement>(null);
  useEffect(() => {
    if (highlightedSessionId) list.current?.querySelector(".new-booking-highlight")?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [highlightedSessionId]);
  return <section ref={list} className="schedule-agenda" aria-label="Accessible week schedule">
    <h2 className="sr-only">Classes by day</h2>
    {!groups.size && <p>No classes scheduled for this day.</p>}
    {[...groups].map(([date, events]) => <section key={date} aria-labelledby={`agenda-${date}`} className="agenda-day">
      <h3 id={`agenda-${date}`}>{new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`))}</h3>
      <ul role="list">{events.map((event) => {
        const info = data.details[String(event.id)];
        const change = plan?.sessionChanges.find((item) => item.after && `${item.sessionId}-new` === event.id);
        return <li key={String(event.id)} className={`agenda-class${event.id === (plan ? `${highlightedSessionId}-new` : highlightedSessionId) ? " new-booking-highlight" : ""}`}>
          <h4>{info.title} · {info.status}</h4><p>{info.time}</p>
          <p>{state.instructors.find((item) => item.id === event.resourceId)?.name} · {info.room}</p>
          <p>{info.occupancy}{info.badge && <> · <span className="session-badge">{info.badge}</span></>}</p>
          {change && onMove && <button data-move-session={change.sessionId} onClick={() => onMove(change.sessionId)}>Move {info.title} to…</button>}
        </li>;
      })}</ul>
    </section>)}
    {data.resourceTimeRanges.length + data.timeRanges.length > 0 && <section className="agenda-day" aria-label="Unavailability"><h3>Unavailability</h3><ul role="list">{[...data.resourceTimeRanges, ...data.timeRanges].map((range) =>
      <li key={String(range.id)}>{range.name} · {new Date(String(range.startDate)).toLocaleString("en-US", { timeZone: state.studio.timezone })} – {new Date(String(range.endDate)).toLocaleString("en-US", { timeZone: state.studio.timezone })}</li>)}</ul></section>}
  </section>;
}
