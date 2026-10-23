import { describe, expect, it } from "vitest";
import { classColors, disruptionLabel, formatTime, mapSchedule, weekBounds } from "../lib/client/scheduler-mapping";
import { demoDisruption, seedStudio } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { applyPlan } from "../lib/solver/validate";

describe("scheduler presentation mapping", () => {
  it("maps stable instructor and room resources without mutating the state", () => {
    const state = seedStudio();
    const before = structuredClone(state);
    for (const mode of ["instructors", "rooms"] as const) {
      const mapped = mapSchedule(state, mode);
      expect(mapped.resources).toEqual((mode === "instructors" ? state.instructors : state.rooms).map(({ id, name }) => ({ id, name })));
      expect(mapped.events).toHaveLength(state.sessions.length);
      for (const session of state.sessions) {
        expect(mapped.events.find((event) => event.id === session.id)).toMatchObject({
          resourceId: mode === "instructors" ? session.instructorId : session.roomId,
          startDate: session.start, endDate: session.end, draggable: false, resizable: false,
        });
        expect(mapped.details[session.id].location).toBe(mode === "instructors"
          ? state.rooms.find((room) => room.id === session.roomId)!.name
          : state.instructors.find((instructor) => instructor.id === session.instructorId)!.name);
      }
      expect(mapped.dependencies).toEqual([]);
      expect(mapped.resourceTimeRanges).toEqual([]);
      expect(mapped.timeRanges).toEqual([]);
    }
    expect(state).toEqual(before);
  });

  it("pairs original ghosts and replacements and connects real event ids", () => {
    const state = seedStudio();
    const plan = replan(state, demoDisruption);
    const mapped = mapSchedule(state, "instructors", plan);
    const replacements = plan.sessionChanges.filter((change) => change.after);
    expect(mapped.events.filter((event) => String(event.cls).includes("ghost"))).toHaveLength(replacements.length);
    expect(mapped.events.filter((event) => String(event.cls).includes("replacement"))).toHaveLength(replacements.length);
    expect(mapped.dependencies).toHaveLength(replacements.length);
    for (const change of replacements) {
      expect(mapped.events.find((event) => event.id === `${change.sessionId}-new`)).toMatchObject({
        resourceId: change.after!.instructorId, startDate: change.after!.start, endDate: change.after!.end,
      });
      expect(mapped.dependencies.find((dependency) => dependency.id === `${change.sessionId}-recovery`)).toMatchObject({
        from: `${change.sessionId}-original`, to: `${change.sessionId}-new`, type: 2,
      });
      const session = state.sessions.find((item) => item.id === change.sessionId)!;
      const retained = state.bookings.filter((booking) => booking.sessionId === session.id &&
        !plan.bookingActions.some((action) => action.bookingId === booking.id && action.action === "refund")).length;
      expect(mapped.details[`${session.id}-new`].occupancy).toBe(`${retained}/${session.capacity} booked`);
    }
    expect(mapped.resourceTimeRanges).toMatchObject([{ resourceId: "instructor-01", startDate: demoDisruption.from, endDate: demoDisruption.to }]);
    expect(new Set(mapped.events.map((event) => event.id)).size).toBe(mapped.events.length);
  });

  it("shows cancelled sessions with no replacement or dangling dependency, and shades closures", () => {
    const state = seedStudio();
    const plan = replan(state, { kind: "closure", from: state.studio.weekStart, to: "2026-11-16T05:00:00Z" }, { horizonDays: 0 });
    const mapped = mapSchedule(state, "rooms", plan);
    const cancellations = plan.sessionChanges.filter((change) => change.remedy === "cancel");
    expect(cancellations.length).toBeGreaterThan(0);
    for (const change of cancellations) {
      expect(mapped.events.find((event) => event.id === `${change.sessionId}-original`)?.cls).toContain("cancelled");
      expect(mapped.events.some((event) => event.id === `${change.sessionId}-new`)).toBe(false);
      expect(mapped.dependencies.some((dependency) => dependency.from === `${change.sessionId}-original`)).toBe(false);
    }
    expect(mapped.timeRanges).toMatchObject([{ startDate: plan.disruption.from, endDate: plan.disruption.to, cls: "disruption-range" }]);
    expect(mapped.resourceTimeRanges).toEqual([]);
  });

  it("maps a room disruption to affected instructors when rows switch", () => {
    const state = seedStudio();
    const session = state.sessions.find((item) => item.roomId === "room-03")!;
    const plan = replan(state, { kind: "room_unavailable", roomId: session.roomId, from: session.start, to: session.end });
    const rooms = mapSchedule(state, "rooms", plan);
    expect(rooms.resourceTimeRanges).toMatchObject([{ resourceId: session.roomId }]);
    const instructors = mapSchedule(state, "instructors", plan);
    expect(instructors.resourceTimeRanges.map((range) => range.resourceId)).toContain(session.instructorId);
    expect(instructors.resourceTimeRanges.every((range) => state.instructors.some((item) => item.id === range.resourceId))).toBe(true);
  });

  it("settles the approved state with no ghosts, arrows, ranges, or cancelled events", () => {
    const state = seedStudio();
    const plan = replan(state, { kind: "closure", from: state.studio.weekStart, to: "2026-11-16T05:00:00Z" }, { horizonDays: 0 });
    const settled = applyPlan(state, plan);
    const mapped = mapSchedule(settled, "instructors");
    expect(mapped.events).toHaveLength(settled.sessions.length);
    expect(mapped.events.every((event) => !String(event.cls).match(/ghost|replacement|cancelled/))).toBe(true);
    expect(mapped.dependencies).toEqual([]);
    expect(mapped.timeRanges).toEqual([]);
    for (const change of plan.sessionChanges) expect(mapped.events.some((event) => event.id === change.sessionId)).toBe(Boolean(change.after));
  });

  it("uses the studio local week and clock regardless of the viewer timezone, including DST", () => {
    const state = seedStudio(42, "2026-10-26T04:00:00Z");
    expect(weekBounds(state)).toEqual({ startKey: "2026-10-26", start: "2026-10-26T04:00:00.000Z", end: "2026-11-02T05:00:00.000Z", label: "Mon Oct 26 - Sun Nov 1" });
    expect(formatTime("2026-11-09T12:00:00Z", "America/New_York")).toBe("7:00 AM");
    const label = disruptionLabel({ disruption: demoDisruption }, seedStudio());
    expect(label.subject).toContain("Maya");
    expect(label.window).toContain("Mon, Nov 9");
    expect(Object.keys(classColors)).toHaveLength(6);
  });
});
