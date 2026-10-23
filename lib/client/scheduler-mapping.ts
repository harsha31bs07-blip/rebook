import type { DependencyModelConfig, EventModelConfig, ResourceModelConfig, ResourceTimeRangeModelConfig, TimeSpanConfig } from "@bryntum/scheduler";
import type { Plan, Session, State } from "../domain/types";
import { addLocalDays, localParts, overlaps, zonedTimeToUtc } from "../domain/time";

export type RowMode = "instructors" | "rooms";
export const visibleWorkingTime = { fromHour: 7, toHour: 21 };
export const classColors = {
  yoga: ["#dbeafe", "#1e3a8a"], pilates: ["#dcfce7", "#14532d"],
  spin: ["#fef3c7", "#78350f"], dance: ["#fce7f3", "#831843"],
  hiit: ["#fee2e2", "#7f1d1d"], barre: ["#ede9fe", "#4c1d95"],
} as const;

export function formatTime(instant: string, timezone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(new Date(instant));
}

export function weekBounds(state: State) {
  const startKey = localParts(state.studio.weekStart, state.studio.timezone).dateKey;
  const format = (key: string) => new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric",
  }).format(new Date(`${key}T12:00:00Z`)).replaceAll(",", "");
  return {
    start: zonedTimeToUtc(startKey, "00:00", state.studio.timezone),
    end: zonedTimeToUtc(addLocalDays(startKey, 7), "00:00", state.studio.timezone),
    label: `${format(startKey)} - ${format(addLocalDays(startKey, 6))}`,
    startKey,
  };
}

export function formatDisruptionWindow(from: string, to: string, timezone: string) {
  const start = localParts(from, timezone);
  const end = localParts(to, timezone);
  const date = (key: string) => new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric",
  }).format(new Date(`${key}T12:00:00Z`));
  if (start.minutesOfDay === 0 && end.minutesOfDay === 0) {
    const lastDay = addLocalDays(end.dateKey, -1);
    return start.dateKey === lastDay ? `All day ${date(start.dateKey)}` : `${date(start.dateKey)} - ${date(lastDay)} (all day)`;
  }
  return start.dateKey === end.dateKey
    ? `${date(start.dateKey)}, ${formatTime(from, timezone)} - ${formatTime(to, timezone)}`
    : `${date(start.dateKey)}, ${formatTime(from, timezone)} - ${date(end.dateKey)}, ${formatTime(to, timezone)}`;
}

export function interpretationSource(source: string, model?: string) {
  if (source !== "gemini") return "Rules";
  if (model?.includes("flash-lite")) return "Gemini Flash-Lite";
  if (model?.includes("flash")) return "Gemini Flash";
  return "Gemini";
}

/** Whole affected days, clamped to the studio week; use wall dates for the time axis. */
export function recoveryBounds(state: State, plan: Plan) {
  const week = weekBounds(state);
  const timezone = state.studio.timezone;
  const keys = [localParts(plan.disruption.from, timezone).dateKey,
    localParts(new Date(Date.parse(plan.disruption.to) - 1).toISOString(), timezone).dateKey,
    ...plan.sessionChanges.flatMap((change) => [change.before.start, change.before.end,
      ...(change.after ? [change.after.start, change.after.end] : [])].map((value) => localParts(value, timezone).dateKey))].sort();
  const lastKey = addLocalDays(week.startKey, 6);
  const clamp = (key: string) => key < week.startKey ? week.startKey : key > lastKey ? lastKey : key;
  return { startKey: clamp(keys[0]), endKey: addLocalDays(clamp(keys.at(-1)!), 1) };
}

export function disruptionLabel(plan: Pick<Plan, "disruption">, state: State) {
  const disruption = plan.disruption;
  const subject = disruption.kind === "closure" ? "Studio closed" : disruption.kind === "instructor_unavailable"
    ? `${state.instructors.find((item) => item.id === disruption.instructorId)?.name ?? "Instructor"} unavailable`
    : `${state.rooms.find((item) => item.id === disruption.roomId)?.name ?? "Room"} unavailable`;
  return { subject, window: formatDisruptionWindow(disruption.from, disruption.to, state.studio.timezone) };
}

export function mapSchedule(state: State, mode: RowMode, plan?: Plan, updatedPlan?: Plan) {
  const resources: ResourceModelConfig[] = (mode === "instructors" ? state.instructors : state.rooms).map(({ id, name }) => ({ id, name }));
  const events: EventModelConfig[] = [];
  const dependencies: DependencyModelConfig[] = [];
  const resourceTimeRanges: ResourceTimeRangeModelConfig[] = [];
  const timeRanges: TimeSpanConfig[] = [];
  const details: Record<string, { title: string; time: string; location: string; room: string; occupancy: string; status: string; badge: string }> = {};
  function addEvent(session: Session, id: string, variant = "") {
    const active = state.bookings.filter((booking) => booking.sessionId === session.id && ["confirmed", "moved"].includes(booking.status));
    const bookings = variant === "replacement" && plan ? active.filter((booking) => !plan.bookingActions.some((action) => action.bookingId === booking.id && action.action === "refund")) : active;
    const location = mode === "instructors" ? state.rooms.find((item) => item.id === session.roomId)?.name : state.instructors.find((item) => item.id === session.instructorId)?.name;
    const change = plan?.sessionChanges.find((item) => item.sessionId === session.id);
    const instructor = state.instructors.find((item) => item.id === session.instructorId)?.name.split(" ")[0] ?? "substitute";
    details[id] = {
      title: session.title, time: `${formatTime(session.start, state.studio.timezone)} – ${formatTime(session.end, state.studio.timezone)}`,
      location: location ?? "", room: state.rooms.find((item) => item.id === session.roomId)?.name ?? "",
      occupancy: `${bookings.length}/${session.capacity} booked`,
      status: variant === "ghost" ? "Original" : variant === "replacement" ? "Recovery" : variant === "cancelled" ? "Cancelled" : "Scheduled",
      badge: variant === "replacement" ? change?.remedy === "substitute" ? `Covered by ${instructor}` : "Moved" : variant === "updated" ? "Updated" : "",
    };
    events.push({ id, name: session.title, resourceId: mode === "instructors" ? session.instructorId : session.roomId,
      startDate: session.start, endDate: session.end, cls: `class-${session.classType} ${variant}`, draggable: false, resizable: false,
    });
  }
  for (const session of state.sessions) {
    const change = plan?.sessionChanges.find((item) => item.sessionId === session.id);
    if (!change) addEvent(session, session.id, updatedPlan?.sessionChanges.some((item) => item.sessionId === session.id && item.after) ? "updated" : "");
    else {
      addEvent({ ...session, ...change.before }, `${session.id}-original`, change.after ? "ghost" : "cancelled");
      if (change.after) {
        addEvent({ ...session, ...change.after }, `${session.id}-new`, "replacement");
        if (change.remedy === "move_time") dependencies.push({ id: `${session.id}-recovery`, from: `${session.id}-original`, to: `${session.id}-new`, type: 2 });
      }
    }
  }
  if (plan) {
    const disruption = plan.disruption;
    const band = { id: "disruption", startDate: disruption.from, endDate: disruption.to, name: disruptionLabel(plan, state).subject, cls: "disruption-range" };
    if (disruption.kind === "closure") timeRanges.push(band);
    else {
      const sameMode = disruption.kind === "instructor_unavailable" ? mode === "instructors" : mode === "rooms";
      const affectedIds = sameMode ? [disruption.kind === "instructor_unavailable" ? disruption.instructorId : disruption.roomId]
        : [...new Set(state.sessions.filter((session) => overlaps(session.start, session.end, disruption.from, disruption.to) &&
          (disruption.kind === "instructor_unavailable" ? session.instructorId === disruption.instructorId : session.roomId === disruption.roomId))
          .map((session) => mode === "instructors" ? session.instructorId : session.roomId))];
      affectedIds.forEach((resourceId) => resourceTimeRanges.push({ ...band, id: `disruption-${resourceId}`, resourceId }));
    }
  }
  return { resources, events, dependencies, resourceTimeRanges, timeRanges, details };
}
