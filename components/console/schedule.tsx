"use client";

import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { BryntumScheduler, type BryntumSchedulerProps } from "@bryntum/scheduler-react";
import { StringHelper, TimeZoneHelper, type ResourceModel } from "@bryntum/scheduler";
import { checkAdjustment, type OwnerAdjustment } from "@/lib/solver/adjust";
import type { Plan, State } from "@/lib/domain/types";
import { addLocalDays, zonedTimeToUtc } from "@/lib/domain/time";
import { mapSchedule, recoveryBounds, recoveryDropStart, resourceUtilisation, visibleWorkingTime, weekBounds, type RowMode } from "@/lib/client/scheduler-mapping";

export default function Schedule({ state, mode, zoom, day, plan, updatedPlan, highlightedSessionId, busy, onAdjust, onMove }: {
  state: State; mode: RowMode; zoom: "day" | "week"; day: number; plan?: Plan; updatedPlan?: Plan; highlightedSessionId?: string; busy?: boolean; onAdjust?: (input: OwnerAdjustment) => Promise<void>; onMove?: (sessionId: string) => void;
}) {
  const latest = useRef({ state, plan, busy, onAdjust, mode });
  useEffect(() => { latest.current = { state, plan, busy, onAdjust, mode }; }, [state, plan, busy, onAdjust, mode]);
  const [dropError, setDropError] = useState("");
  const schedulerRef = useRef<BryntumScheduler>(null);
  const data = useMemo(() => {
    const mapped = mapSchedule(state, mode, plan, updatedPlan);
    if (highlightedSessionId) for (const event of mapped.events) {
      if ([highlightedSessionId, `${highlightedSessionId}-new`].includes(String(event.id))) event.cls = `${event.cls} new-booking-highlight`;
    }
    return mapped;
  }, [state, mode, plan, updatedPlan, highlightedSessionId]);
  const bounds = weekBounds(state);
  // Initial axis bounds are instants: the project's timeZone converts them along with events.
  const startKey = zoom === "day" ? addLocalDays(bounds.startKey, day) : bounds.startKey;
  const endKey = addLocalDays(startKey, zoom === "day" ? 1 : 7);
  const [config] = useState<BryntumSchedulerProps>(() => ({
    height: "100%", width: "100%", snap: true, multiEventSelect: false,
    rowHeight: 112, barMargin: 5, eventLayout: "stack", eventStyle: "filled",
    // Week cards fill day cells; their labels retain exact times. Day view uses true hourly widths.
    fillTicks: zoom === "week", weekStartDay: 1, workingTime: visibleWorkingTime,
    autoAdjustTimeAxis: false,
    startDate: zonedTimeToUtc(startKey, zoom === "week" ? "00:00" : "07:00", state.studio.timezone),
    endDate: zonedTimeToUtc(endKey, "00:00", state.studio.timezone),
    timeZone: state.studio.timezone,
    viewPreset: {
      id: `rebook-${zoom}`, tickWidth: zoom === "week" ? 240 : 150,
      timeResolution: { unit: "minute", increment: 15 },
      headers: zoom === "week" ? [{ unit: "day", dateFormat: "ddd MMM D" }]
        : [{ unit: "day", dateFormat: "ddd MMM D" }, { unit: "hour", increment: 1, dateFormat: "ha" }],
    },
    getDateConstraints: () => ({ start: new Date(`${bounds.startKey}T00:00:00`), end: new Date(`${addLocalDays(bounds.startKey, 7)}T00:00:00`) }),
    eventDragFeature: {
      constrainDragToTimeline: true, constrainDragToResource: false, copyKey: "", showTooltip: true, showExactDropPosition: true,
      validatorFn: ({ eventRecords, startDate, newResource }, event) => {
        const current = latest.current;
        const change = current.plan?.sessionChanges.find((item) => `${item.sessionId}-new` === String(eventRecords[0]?.id));
        if (!current.plan || !change?.after || current.busy || !current.onAdjust || !newResource) return { valid: false, message: "Only recovery blocks in a preview can be moved." };
        const target = zoom === "week" ? schedulerRef.current?.instance.getDateFromDomEvent(event, "floor") ?? startDate : startDate;
        return checkAdjustment(current.state, current.plan, { sessionId: change.sessionId,
          start: recoveryDropStart(change.after.start, target, current.state.studio.timezone, zoom),
          ...(current.mode === "instructors" ? { instructorId: String(newResource.id) } : { roomId: String(newResource.id) }) });
      },
    }, eventResizeFeature: false, eventDragCreateFeature: false,
    eventEditFeature: false, eventMenuFeature: false, scheduleMenuFeature: false,
    cellEditFeature: false, stickyEventsFeature: false,
    dependenciesFeature: { allowCreate: false, radius: 6, renderer: ({ domConfig, fromAssignmentRecord, toAssignmentRecord }) => {
      const scheduler = schedulerRef.current?.instance;
      if (!scheduler) return;
      const { startDate, endDate } = scheduler.visibleDateRange;
      const visible = [fromAssignmentRecord.event, toAssignmentRecord.event].every((event) =>
        typeof event === "object" && startDate && endDate && event.startDate >= startDate && event.endDate <= endDate);
      domConfig.style = { display: visible ? "" : "none" };
    } }, dependencyEditFeature: false, dependencyMenuFeature: false,
    resourceTimeRangesFeature: true, timeRangesFeature: { showCurrentTimeLine: false },
    columnLinesFeature: true, headerMenuFeature: false, timeAxisHeaderMenuFeature: false,
    zoomOnMouseWheel: false, zoomOnTimeAxisDoubleClick: false,
  }));
  const focusPlan = plan ?? updatedPlan;
  const focus = focusPlan && (plan ? { startKey: bounds.startKey, endKey: addLocalDays(bounds.startKey, 7) } : recoveryBounds(state, focusPlan));
  const focusStart = focus?.startKey;
  const focusEnd = focus?.endKey;
  useEffect(() => {
    const scheduler = schedulerRef.current?.instance;
    if (!scheduler || zoom !== "week" || !focusStart || !focusEnd) return;
    // Runtime timeline methods use wall dates after the project's initial timezone conversion.
    const startDate = new Date(`${focusStart}T00:00:00`);
    const endDate = new Date(`${focusEnd}T00:00:00`);
    const days = Math.round((Date.parse(focusEnd) - Date.parse(focusStart)) / 86400000);
    const fit = () => {
      if (scheduler.isDestroyed) return;
      // Retain day cards while fitting every original/recovery day in the available viewport.
      scheduler.zoomToLevel({
        id: `rebook-recovery-${days}`, tickWidth: Math.floor(Number(scheduler.subGrids.normal.width) / days),
        timeResolution: { unit: "minute", increment: 15 }, headers: [{ unit: "day", dateFormat: "ddd MMM D" }],
      }, { startDate, endDate });
      void scheduler.scrollToDate(startDate, { block: "start", animate: false });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [focusStart, focusEnd, zoom]);
  const renderer = useMemo<NonNullable<BryntumSchedulerProps["eventRenderer"]>>(() => ({ eventRecord, renderData }) => {
    const info = data.details[String(eventRecord.id)];
    if (!info) return StringHelper.encodeHtml(eventRecord.name);
    renderData.iconCls = "";
    renderData.ariaLabel = `${info.status}: ${info.title}, ${info.time}, ${info.room}, ${info.location}, ${info.occupancy}`;
    return [{ tag: "div", className: "session-label", children: [
      { tag: "strong", text: info.title }, { tag: "span", text: info.time },
      ...(zoom === "day" ? [{ tag: "span", text: info.location }, { tag: "span", text: info.occupancy }] : []),
      ...(zoom === "day" && mode === "rooms" ? [{ tag: "span", text: info.room }] : []),
      ...(info.badge ? [{ tag: "span", className: "session-badge", text: info.badge }] : []),
      ...(plan?.sessionChanges.some((change) => change.after && `${change.sessionId}-new` === String(eventRecord.id)) && onMove ? [{
        tag: "button", type: "button", className: "recovery-move", text: "Move", disabled: Boolean(busy),
        "aria-label": `Move ${info.title} to…`, "aria-haspopup": "dialog",
      }] : []),
    ] }];
  }, [data.details, zoom, mode, plan, onMove, busy]);
  const tooltip = useMemo(() => ({ template: ({ eventRecord }: { eventRecord: { id: string | number } }) => {
    const info = data.details[String(eventRecord.id)];
    const location = info && (mode === "rooms" ? `${info.room} · ${info.location}` : info.location);
    return info ? `<strong>${StringHelper.encodeHtml(info.title)}</strong><p>${StringHelper.encodeHtml(info.time)}</p><p>${StringHelper.encodeHtml(`${location} · ${info.occupancy} · ${info.status}`)}</p>` : "";
  } }), [data.details, mode]);
  const columns = useMemo<NonNullable<BryntumSchedulerProps["columns"]>>(() => [{
    field: "name", text: mode === "instructors" ? "Instructors / daily load" : "Rooms / daily load", width: 200, htmlEncode: false,
    renderer: ({ record }: { record: ResourceModel }) => {
      const resource = mode === "instructors" ? state.instructors.find((item) => item.id === record.id) : state.rooms.find((item) => item.id === record.id);
      const skills = resource && ("skills" in resource ? resource.skills : resource.supports);
      const loads = resourceUtilisation(state, mode, String(record.id), plan);
      const selected = zoom === "day" ? [loads[day]] : loads;
      const text = selected.map((item) => `${item.label} ${Number(item.booked.toFixed(2))}/${item.capacity}`).join(" | ");
      return `<div class="resource-name">${StringHelper.encodeHtml(record.name)}</div><div class="resource-skills">${skills?.map((skill) => `<span class="skill-chip class-${skill}">${StringHelper.encodeHtml(skill)}</span>`).join("") ?? ""}</div><div class="resource-load" title="Booked / daily capacity (${loads[0].unit})">${StringHelper.encodeHtml(text)}</div>`;
    },
  }], [state, mode, plan, zoom, day]);
  const editable = Boolean(plan && onAdjust && !busy);
  useEffect(() => {
    const scheduler = schedulerRef.current?.instance;
    scheduler?.features.eventDrag.setConfig({ disabled: !editable });
  }, [editable]);
  function openMove(event: SyntheticEvent<HTMLElement>) {
    if (!editable || !onMove) return;
    const record = schedulerRef.current?.instance.resolveEventRecord(event.target as HTMLElement);
    const change = plan?.sessionChanges.find((item) => item.after && `${item.sessionId}-new` === String(record?.id));
    if (change) { event.preventDefault(); event.stopPropagation(); onMove(change.sessionId); }
  }
  return <div className="schedule-interactions" onClickCapture={(event) => {
    if ((event.target as HTMLElement).closest(".recovery-move")) openMove(event);
  }} onKeyDownCapture={(event) => {
    if (event.key === "Enter" || event.key === " ") openMove(event);
  }}><BryntumScheduler ref={schedulerRef} {...config} resources={data.resources} events={data.events}
    dependencies={data.dependencies} resourceTimeRanges={data.resourceTimeRanges} timeRanges={data.timeRanges}
    columns={columns} readOnly={!editable}
    onBeforeEventDrag={({ eventRecord, domEvent }) => editable && !(domEvent.target as HTMLElement).closest("button") && Boolean(plan?.sessionChanges.some((item) => item.after && `${item.sessionId}-new` === String(eventRecord.id)))}
    onBeforeEventDropFinalize={({ context, domEvent }) => {
      context.async = true;
      const change = plan?.sessionChanges.find((item) => `${item.sessionId}-new` === String(context.eventRecords[0]?.id));
      if (!editable || !change?.after || !onAdjust || !context.valid) { context.finalize(false); return; }
      const target = zoom === "week" ? schedulerRef.current?.instance.getDateFromDomEvent(domEvent, "floor") ?? context.startDate : context.startDate;
      const start = recoveryDropStart(change.after.start, target, state.studio.timezone, zoom);
      context.startDate = TimeZoneHelper.toTimeZone(new Date(start), state.studio.timezone);
      context.endDate = TimeZoneHelper.toTimeZone(new Date(Date.parse(start) + Date.parse(change.after.end) - Date.parse(change.after.start)), state.studio.timezone);
      for (const drop of context.dropData.events) {
        if (String(drop.eventRecord.id) === `${change.sessionId}-new`) {
          drop.startDate = context.startDate; drop.endDate = context.endDate;
        }
      }
      setDropError("");
      void onAdjust({ sessionId: change.sessionId, start,
        ...(mode === "instructors" ? { instructorId: String(context.newResource.id) } : { roomId: String(context.newResource.id) }) })
        .then(() => context.finalize(true), (error: unknown) => {
          setDropError(error instanceof Error ? error.message : "This placement is unavailable.");
          context.finalize(false);
        });
    }}
    onEventKeyDown={({ eventRecords, event }) => {
      if (!["Enter", " "].includes(event.key) || !editable) return;
      const change = plan?.sessionChanges.find((item) => item.after && `${item.sessionId}-new` === String(eventRecords[0]?.id));
      if (change) { event.preventDefault(); onMove?.(change.sessionId); }
    }}
    eventRenderer={renderer} eventTooltipFeature={tooltip} labelsFeature={false} />
    {dropError && <div className="drop-reason" role="tooltip"><span role="alert">{dropError}</span><button aria-label="Dismiss move error" onClick={() => setDropError("")}>Dismiss</button></div>}
    </div>;
}
