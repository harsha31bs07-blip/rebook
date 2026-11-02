import type { State } from "../domain/types";
import { localParts } from "../domain/time";

const DEMO = ["Maya has the flu and can't teach Monday", "The Cycle Lab AC is broken Wednesday afternoon", "Studio closed Saturday morning for a burst pipe"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The scripted demo studio, as opposed to a week an owner imported. */
export const isSeededDemo = (state: State) => state.studio.id === "studio-rebook";

/** Example disruptions written with this studio's own instructors, rooms and busy days. The seeded demo keeps its scripted three. */
export function disruptionExamples(state: State): string[] {
  if (isSeededDemo(state)) return DEMO;
  const tz = state.studio.timezone;
  const classes = [...state.sessions].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).map((session) => ({ session, ...localParts(session.start, tz) }));
  if (!classes.length) return [];
  const examples: string[] = [];
  const first = classes[0];
  const busiest = Object.entries(Object.groupBy(classes.filter((item) => item.dateKey === first.dateKey), (item) => item.session.instructorId))
    .sort((a, b) => (b[1]?.length ?? 0) - (a[1]?.length ?? 0))[0][0];
  const name = state.instructors.find((item) => item.id === busiest)?.name.split(/\s+/)[0];
  if (name) examples.push(`${name} has the flu and can't teach ${DAYS[first.weekday]}`);
  const afternoon = state.rooms.length > 1 ? classes.find((item) => item.minutesOfDay >= 12 * 60 && item.minutesOfDay < 17 * 60) : undefined;
  const room = afternoon && state.rooms.find((item) => item.id === afternoon.session.roomId)?.name;
  if (afternoon && room) examples.push(`The ${room} is unavailable ${DAYS[afternoon.weekday]} afternoon`);
  const morning = [...classes].reverse().find((item) => item.minutesOfDay < 12 * 60);
  if (morning) examples.push(`Studio closed ${DAYS[morning.weekday]} morning for a burst pipe`);
  return examples;
}
