import type { Plan, State } from "../domain/types";

export type CoverConfirmation = {
  sessionId: string; instructorId: string; confirmedBy: string; confirmedAt: string;
};

export function planCovers(plan: Plan, state: State) {
  return plan.sessionChanges.flatMap((change) => {
    if (!change.after || change.after.instructorId === change.before.instructorId) return [];
    const instructor = state.instructors.find((item) => item.id === change.after!.instructorId);
    const session = state.sessions.find((item) => item.id === change.sessionId);
    const when = new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(change.after.start));
    return [{ sessionId: change.sessionId, instructorId: change.after.instructorId,
      instructor: instructor?.name ?? "Studio team", label: `${instructor?.name ?? "Studio team"} covers ${session?.title ?? "Class"} ${when}` }];
  });
}
