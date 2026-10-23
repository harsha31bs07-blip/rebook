"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BryntumScheduler, type BryntumSchedulerProps } from "@bryntum/scheduler-react";
import { StringHelper, type ResourceModel } from "@bryntum/scheduler";
import type { Plan, State } from "@/lib/domain/types";
import { addLocalDays } from "@/lib/domain/time";
import { mapSchedule, recoveryBounds, visibleWorkingTime, weekBounds, type RowMode } from "@/lib/client/scheduler-mapping";

export default function Schedule({ state, mode, zoom, day, plan, updatedPlan }: {
  state: State; mode: RowMode; zoom: "day" | "week"; day: number; plan?: Plan; updatedPlan?: Plan;
}) {
  const schedulerRef = useRef<BryntumScheduler>(null);
  const data = useMemo(() => mapSchedule(state, mode, plan, updatedPlan), [state, mode, plan, updatedPlan]);
  const bounds = weekBounds(state);
  // Axis dates represent wall time in the studio; event ISO instants are converted by timeZone.
  const startKey = zoom === "day" ? addLocalDays(bounds.startKey, day) : bounds.startKey;
  const endKey = addLocalDays(startKey, zoom === "day" ? 1 : 7);
  const [config] = useState<BryntumSchedulerProps>(() => ({
    height: "100%", width: "100%", readOnly: true,
    rowHeight: zoom === "week" ? 76 : 112, barMargin: 5, eventLayout: "stack", eventStyle: "filled",
    // Week cards fill day cells; their labels retain exact times. Day view uses true hourly widths.
    fillTicks: zoom === "week", weekStartDay: 1, workingTime: visibleWorkingTime,
    autoAdjustTimeAxis: false,
    startDate: `${startKey}T${zoom === "week" ? "00" : "07"}:00:00`, endDate: `${endKey}T00:00:00`,
    timeZone: state.studio.timezone,
    viewPreset: {
      id: `rebook-${zoom}`, tickWidth: zoom === "week" ? 240 : 150,
      timeResolution: { unit: "minute", increment: 15 },
      headers: zoom === "week" ? [{ unit: "day", dateFormat: "ddd MMM D" }]
        : [{ unit: "day", dateFormat: "ddd MMM D" }, { unit: "hour", increment: 1, dateFormat: "ha" }],
    },
    columns: [{ field: "name", text: mode === "instructors" ? "Instructors" : "Rooms", width: 184, htmlEncode: false,
      renderer: ({ record }: { record: ResourceModel }) => {
        const resource = mode === "instructors" ? state.instructors.find((item) => item.id === record.id) : state.rooms.find((item) => item.id === record.id);
        const skills = resource && ("skills" in resource ? resource.skills : resource.supports);
        return `<div class="resource-name">${StringHelper.encodeHtml(record.name)}</div><div class="resource-skills">${skills?.map((skill) => `<span class="skill-chip class-${skill}">${StringHelper.encodeHtml(skill)}</span>`).join("") ?? ""}</div>`;
      },
    }],
    eventDragFeature: false, eventResizeFeature: false, eventDragCreateFeature: false,
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
  const focus = focusPlan && recoveryBounds(state, focusPlan);
  const focusStart = focus?.startKey;
  const focusEnd = focus?.endKey;
  useEffect(() => {
    const scheduler = schedulerRef.current?.instance;
    if (!scheduler || zoom !== "week" || !focusStart || !focusEnd) return;
    const startDate = new Date(`${focusStart}T07:00:00`);
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
    ] }];
  }, [data.details, zoom, mode]);
  const tooltip = useMemo(() => ({ template: ({ eventRecord }: { eventRecord: { id: string | number } }) => {
    const info = data.details[String(eventRecord.id)];
    const location = info && (mode === "rooms" ? `${info.room} · ${info.location}` : info.location);
    return info ? `<strong>${StringHelper.encodeHtml(info.title)}</strong><p>${StringHelper.encodeHtml(info.time)}</p><p>${StringHelper.encodeHtml(`${location} · ${info.occupancy} · ${info.status}`)}</p>` : "";
  } }), [data.details, mode]);
  return <BryntumScheduler ref={schedulerRef} {...config} resources={data.resources} events={data.events}
    dependencies={data.dependencies} resourceTimeRanges={data.resourceTimeRanges} timeRanges={data.timeRanges}
    eventRenderer={renderer} eventTooltipFeature={tooltip} labelsFeature={false} />;
}
