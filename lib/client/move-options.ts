import type { Session, State } from "../domain/types";
import { insideOpenHours, zonedTimeToUtc } from "../domain/time";
import { formatTime } from "./scheduler-mapping";

export function moveDayLabel(dateKey: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })
    .format(new Date(`${dateKey}T12:00:00Z`)).replaceAll(",", "");
}

/** Quarter-hour starts that leave enough time for the whole class, including split hours. */
export function moveTimeOptions(state: State, session: Session, dateKey: string) {
  const duration = Date.parse(session.end) - Date.parse(session.start);
  return Array.from({ length: 96 }, (_, index) => {
    const value = `${String(Math.floor(index / 4)).padStart(2, "0")}:${String(index % 4 * 15).padStart(2, "0")}`;
    const start = zonedTimeToUtc(dateKey, value, state.studio.timezone);
    return { value, label: formatTime(start, state.studio.timezone), start };
  }).filter(({ start }) => insideOpenHours(state.studio, start, new Date(Date.parse(start) + duration).toISOString()));
}
