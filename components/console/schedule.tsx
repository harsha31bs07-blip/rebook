"use client";

import { useMemo, useState } from "react";
import { BryntumScheduler, type BryntumSchedulerProps } from "@bryntum/scheduler-react";
import { StringHelper, type LabelsConfig, type ResourceModel } from "@bryntum/scheduler";
import type { Plan, State } from "@/lib/domain/types";
import { addLocalDays } from "@/lib/domain/time";
import { mapSchedule, weekBounds, type RowMode } from "@/lib/client/scheduler-mapping";

export default function Schedule({ state, mode, zoom, day, plan }: {
  state: State; mode: RowMode; zoom: "day" | "week"; day: number; plan?: Plan;
}) {
  const data = useMemo(() => mapSchedule(state, mode, plan), [state, mode, plan]);
  const bounds = weekBounds(state);
  // Axis dates represent wall time in the studio; event ISO instants are converted by timeZone.
  const startKey = zoom === "day" ? addLocalDays(bounds.startKey, day) : bounds.startKey;
  const endKey = addLocalDays(startKey, zoom === "day" ? 1 : 7);
  const [config] = useState<BryntumSchedulerProps>(() => ({
    height: "100%", width: "100%", readOnly: true,
    rowHeight: zoom === "week" ? 60 : 80, barMargin: 4, eventLayout: "stack", eventStyle: null,
    weekStartDay: 1, workingTime: { fromHour: 7, toHour: 21 },
    startDate: `${startKey}T07:00:00`, endDate: `${endKey}T00:00:00`,
    timeZone: state.studio.timezone,
    viewPreset: {
      id: `rebook-${zoom}`, tickWidth: zoom === "week" ? 56 : 96,
      timeResolution: { unit: "minute", increment: 15 },
      headers: [{ unit: "day", dateFormat: "ddd MMM D" }, { unit: "hour", increment: zoom === "week" ? 2 : 1, dateFormat: "ha" }],
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
    dependenciesFeature: { allowCreate: false }, dependencyEditFeature: false, dependencyMenuFeature: false,
    resourceTimeRangesFeature: true, timeRangesFeature: { showCurrentTimeLine: false },
    columnLinesFeature: true, headerMenuFeature: false, timeAxisHeaderMenuFeature: false,
    zoomOnMouseWheel: false, zoomOnTimeAxisDoubleClick: false,
  }));
  const renderer = useMemo<NonNullable<BryntumSchedulerProps["eventRenderer"]>>(() => ({ eventRecord, renderData }) => {
    const info = data.details[String(eventRecord.id)];
    if (!info) return StringHelper.encodeHtml(eventRecord.name);
    renderData.iconCls = "";
    renderData.ariaLabel = `${info.status}: ${info.title}, ${info.time}, ${info.location}, ${info.occupancy}`;
    if (zoom === "week") return "";
    return [{ tag: "div", className: "session-label", children: [
      { tag: "strong", text: info.title }, { tag: "span", text: info.time },
      { tag: "span", text: info.location }, { tag: "span", text: `${info.occupancy}${info.status === "Scheduled" ? "" : ` · ${info.status}`}` },
    ] }];
  }, [data.details, zoom]);
  const labels = useMemo<LabelsConfig>(() => ({
    labelCls: "schedule-event-label", labelLayoutMode: "measure",
    after: { field: "name", renderer: ({ eventRecord }) => {
      const info = eventRecord && data.details[String(eventRecord.id)];
      return info ? `<strong>${StringHelper.encodeHtml(info.title)}</strong><span>${StringHelper.encodeHtml(info.time)}</span><span>${StringHelper.encodeHtml(info.location)}</span><span>${StringHelper.encodeHtml(`${info.occupancy} · ${info.status}`)}</span>` : "";
    } },
  }), [data.details]);
  const tooltip = useMemo(() => ({ template: ({ eventRecord }: { eventRecord: { id: string | number } }) => {
    const info = data.details[String(eventRecord.id)];
    return info ? `<strong>${StringHelper.encodeHtml(info.title)}</strong><p>${StringHelper.encodeHtml(info.time)}</p><p>${StringHelper.encodeHtml(`${info.location} · ${info.occupancy} · ${info.status}`)}</p>` : "";
  } }), [data.details]);
  return <BryntumScheduler {...config} resources={data.resources} events={data.events}
    dependencies={data.dependencies} resourceTimeRanges={data.resourceTimeRanges} timeRanges={data.timeRanges}
    eventRenderer={renderer} eventTooltipFeature={tooltip} labelsFeature={zoom === "week" ? labels : false} />;
}
