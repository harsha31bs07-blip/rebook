import type { DependencyModelConfig, EventModelConfig, ResourceModelConfig, ResourceTimeRangeModelConfig, TimeSpanConfig } from "@bryntum/scheduler";
import { activeConstraints } from "../solver/constraints";
import { applyPlan } from "../solver/validate";
import type { Plan, Session, State } from "../domain/types";
import { addLocalDays, localParts, zonedTimeToUtc } from "../domain/time";

export type RowMode = "instructors" | "rooms";
export const visibleWorkingTime = { fromHour: 7, toHour: 21 };
/** 7am-9pm, widened to every class and opening hour, so an imported 6am class or late class stays on the axis. */
export function workingHours(state: State) {
  const tz = state.studio.timezone, hours = Object.values(state.studio.openHours).flat();
  const starts = [...state.sessions.map((session) => localParts(session.start, tz).minutesOfDay), ...hours.map((item) => clockMinutes(item.open))];
  const ends = [...state.sessions.map((session) => localParts(session.end, tz).minutesOfDay || 24 * 60), ...hours.map((item) => clockMinutes(item.close))];
  return { fromHour: Math.min(visibleWorkingTime.fromHour, ...starts.map((minutes) => Math.floor(minutes / 60))),
    toHour: Math.max(visibleWorkingTime.toHour, ...ends.map((minutes) => Math.ceil(minutes / 60))) };
}
const clockMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
export const hourLabel = (hour: number) => hour % 24 === 0 ? "12am" : hour === 12 ? "12pm" : hour < 12 ? `${hour}am` : `${hour - 12}pm`;
const clockOf = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
export const classColors = {
  yoga: ["#e3ece2", "#2f5238"], pilates: ["#f3e2d6", "#7a3f22"],
  spin: ["#f4e8cc", "#6b4c0b"], dance: ["#f4dfe4", "#7d2f45"],
  hiit: ["#f1dbd4", "#7e2b1f"], barre: ["#e8e0ee", "#4f3563"],
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

/** Focus selects a scroll target only; it must never change the workspace axis. */
export function scheduleRange(state: State, zoom: "day" | "week", day: number, focusPlan?: Plan) {
  const week = weekBounds(state);
  const startKey = zoom === "day" ? addLocalDays(week.startKey, day) : week.startKey;
  const endKey = addLocalDays(startKey, zoom === "day" ? 1 : 7);
  return { startKey, endKey,
    start: zonedTimeToUtc(startKey, zoom === "day" ? clockOf(workingHours(state).fromHour) : "00:00", state.studio.timezone),
    end: zonedTimeToUtc(endKey, "00:00", state.studio.timezone),
    focusKey: focusPlan ? recoveryBounds(state, focusPlan).startKey : startKey };
}

/** Bryntum interaction dates are wall dates; a week cell specifies a day, not a new clock time. */
export function recoveryDropStart(original: string, target: Date, timezone: string, zoom: "day" | "week") {
  const dateKey = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
  const minutes = zoom === "week" ? localParts(original, timezone).minutesOfDay : target.getHours() * 60 + target.getMinutes();
  const clock = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(Math.floor(minutes % 60)).padStart(2, "0")}`;
  return new Date(Date.parse(zonedTimeToUtc(dateKey, clock, timezone)) + Math.round(minutes % 1 * 60_000)).toISOString();
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
  if (source === "groq") return "Groq";
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

/** Daily load includes proposed placements and excludes ghosts and cancellations. */
export function resourceUtilisation(state: State, mode: RowMode, resourceId: string, plan?: Plan) {
  const sessions = (plan ? applyPlan(state, plan) : state).sessions;
  const startKey = weekBounds(state).startKey;
  return Array.from({ length: 7 }, (_, day) => {
    const dateKey = addLocalDays(startKey, day);
    const booked = sessions.filter((item) => (mode === "instructors" ? item.instructorId : item.roomId) === resourceId &&
      localParts(item.start, state.studio.timezone).dateKey === dateKey);
    const weekday = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
    const capacity = mode === "instructors" ? state.instructors.find((item) => item.id === resourceId)?.maxSessionsPerDay ?? 0
      : (state.studio.openHours[weekday] ?? []).reduce((total, hours) => total +
        (Date.parse(zonedTimeToUtc(dateKey, hours.close, state.studio.timezone)) - Date.parse(zonedTimeToUtc(dateKey, hours.open, state.studio.timezone))) / 3600000, 0);
    const load = mode === "instructors" ? booked.length : booked.reduce((total, item) => total + (Date.parse(item.end) - Date.parse(item.start)) / 3600000, 0);
    return { dateKey, label: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day], booked: load, capacity, unit: mode === "instructors" ? "classes" : "hours" };
  });
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
      badge: variant === "replacement" && change?.ownerAdjusted ? "Adjusted by you" : variant === "replacement" ? change?.remedy === "substitute" ? `Covered by ${instructor}` : "Moved" : variant === "updated" ? "Updated" : "",
    };
    events.push({ id, name: session.title, resourceId: mode === "instructors" ? session.instructorId : session.roomId,
      startDate: session.start, endDate: session.end, cls: `class-${session.classType} ${variant}`, draggable: variant === "replacement", resizable: false,
    });
  }
  for (const session of state.sessions) {
    const change = plan?.sessionChanges.find((item) => item.sessionId === session.id);
    if (!change) addEvent(session, session.id, updatedPlan?.sessionChanges.some((item) => item.sessionId === session.id && item.after) ? "updated" : "");
    else {
      addEvent({ ...session, ...change.before }, `${session.id}-original`, change.after ? "ghost" : "cancelled");
      if (change.after) {
        addEvent({ ...session, ...change.after, capacity: Math.min(session.capacity, state.rooms.find((room) => room.id === change.after!.roomId)?.capacity ?? session.capacity) }, `${session.id}-new`, "replacement");
        if (change.remedy === "move_time") dependencies.push({ id: `${session.id}-recovery`, from: `${session.id}-original`, to: `${session.id}-new`, type: 2 });
      }
    }
  }
  const constraints = [...activeConstraints(state), ...(plan ? [plan.disruption] : []),
    ...state.instructors.flatMap((instructor) => (instructor.unavailability ?? []).map((window) => ({ ...window, kind: "instructor_unavailable" as const, instructorId: instructor.id })))];
  const seen = new Set<string>();
  for (const [index, disruption] of constraints.entries()) {
    const key = [disruption.kind, disruption.kind === "instructor_unavailable" ? disruption.instructorId : disruption.kind === "room_unavailable" ? disruption.roomId : "studio", Date.parse(disruption.from), Date.parse(disruption.to)].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const rangeId = index === 0 ? "disruption" : `constraint-${index}`;
    const band = { id: rangeId, startDate: disruption.from, endDate: disruption.to, name: disruptionLabel({ disruption }, state).subject, cls: "disruption-range" };
    if (disruption.kind === "closure") timeRanges.push(band);
    else {
      const sameMode = disruption.kind === "instructor_unavailable" ? mode === "instructors" : mode === "rooms";
      const affectedIds = sameMode ? [disruption.kind === "instructor_unavailable" ? disruption.instructorId : disruption.roomId]
        : [...new Set(state.sessions.filter((session) => (disruption.kind === "instructor_unavailable" ? session.instructorId === disruption.instructorId : session.roomId === disruption.roomId))
          .map((session) => mode === "instructors" ? session.instructorId : session.roomId))];
      if (!affectedIds.length && !sameMode) affectedIds.push(...resources.map((item) => String(item.id)));
      affectedIds.forEach((resourceId) => resourceTimeRanges.push({ ...band, id: `${rangeId}-${resourceId}`, resourceId }));
    }
  }
  return { resources, events, dependencies, resourceTimeRanges, timeRanges, details };
}
