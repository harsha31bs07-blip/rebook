import { describe, expect, it } from "vitest";
import { classColors, disruptionLabel, formatDisruptionWindow, formatTime, hourLabel, interpretationSource, mapSchedule, recoveryBounds, scheduleRange, visibleWorkingTime, weekBounds, workingHours } from "../lib/client/scheduler-mapping";
import { localParts, zonedTimeToUtc } from "../lib/domain/time";
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
        expect(mapped.details[session.id].room).toBe(state.rooms.find((room) => room.id === session.roomId)!.name);
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
    expect(mapped.dependencies).toHaveLength(replacements.filter((change) => change.remedy === "move_time").length);
    for (const change of replacements) {
      expect(mapped.events.find((event) => event.id === `${change.sessionId}-new`)).toMatchObject({
        resourceId: change.after!.instructorId, startDate: change.after!.start, endDate: change.after!.end,
      });
      if (change.remedy === "move_time") {
        expect(mapped.dependencies.find((dependency) => dependency.id === `${change.sessionId}-recovery`)).toMatchObject({
          from: `${change.sessionId}-original`, to: `${change.sessionId}-new`, type: 2,
        });
        expect(mapped.details[`${change.sessionId}-new`].badge).toBe("Moved");
      } else {
        expect(mapped.dependencies.some((dependency) => dependency.id === `${change.sessionId}-recovery`)).toBe(false);
        expect(mapped.details[`${change.sessionId}-new`].badge).toBe("Covered by Alex");
      }
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
  it.each(["2026-10-26T04:00:00Z", "2026-11-09T05:00:00Z"])("includes every class in visible working time for %s, including 7am", (week) => {
    const state = seedStudio(42, week);
    const mapped = mapSchedule(state, "instructors");
    expect(state.sessions.filter((session) => localParts(session.start, state.studio.timezone).minutesOfDay === 420)).toHaveLength(6);
    for (const event of mapped.events) {
      const start = localParts(String(event.startDate), state.studio.timezone);
      const end = localParts(String(event.endDate), state.studio.timezone);
      expect(start.dateKey).toBe(end.dateKey);
      expect(start.minutesOfDay).toBeGreaterThanOrEqual(visibleWorkingTime.fromHour * 60);
      expect(end.minutesOfDay).toBeLessThanOrEqual(visibleWorkingTime.toHour * 60);
    }
  });
  it("widens the axis to an imported 6am class and a class ending at 10pm, and keeps the demo at 7am-9pm", () => {
    const demo = seedStudio();
    expect(workingHours(demo)).toEqual(visibleWorkingTime);
    const state = structuredClone(demo), tz = state.studio.timezone, [early, late] = state.sessions;
    const day = localParts(early.start, tz).dateKey;
    Object.assign(early, { start: zonedTimeToUtc(day, "06:00", tz), end: zonedTimeToUtc(day, "06:45", tz) });
    Object.assign(late, { start: zonedTimeToUtc(day, "21:00", tz), end: zonedTimeToUtc(day, "21:45", tz) });
    expect(workingHours(state)).toEqual({ fromHour: 6, toHour: 22 });
    expect(localParts(scheduleRange(state, "day", 0).start, tz).minutesOfDay).toBe(6 * 60);
    expect([hourLabel(6), hourLabel(12), hourLabel(22)]).toEqual(["6am", "12pm", "10pm"]);
  });
  it("focuses preview and approved recovery on all affected days and retains only Updated badges after approval", () => {
    const state = seedStudio();
    const plan = replan(state, demoDisruption);
    expect(recoveryBounds(state, plan)).toEqual({ startKey: "2026-11-09", endKey: "2026-11-11" });
    const settled = mapSchedule(applyPlan(state, plan), "instructors", undefined, plan);
    expect(settled.dependencies).toEqual([]);
    expect(settled.resourceTimeRanges).toEqual([]);
    expect(settled.events.some((event) => String(event.cls).match(/ghost|replacement/))).toBe(false);
    for (const change of plan.sessionChanges) expect(settled.details[change.sessionId].badge).toBe("Updated");
    expect(mapSchedule(applyPlan(state, plan), "instructors").events.every((event) => !String(event.cls).includes("updated"))).toBe(true);
  });
  it("formats full local days, inclusive multi-day windows, and partial days, including DST", () => {
    const tz = "America/New_York";
    expect(formatDisruptionWindow("2026-10-26T04:00:00Z", "2026-10-27T04:00:00Z", tz)).toBe("All day Mon, Oct 26");
    expect(formatDisruptionWindow("2026-10-26T04:00:00Z", "2026-10-29T04:00:00Z", tz)).toBe("Mon, Oct 26 - Wed, Oct 28 (all day)");
    expect(formatDisruptionWindow("2026-10-28T16:00:00Z", "2026-10-28T21:00:00Z", tz)).toBe("Wed, Oct 28, 12:00 PM - 5:00 PM");
    expect(formatDisruptionWindow("2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z", tz)).toBe("All day Sun, Nov 1");
    expect(interpretationSource("groq", "llama-3.3-70b-versatile")).toBe("Groq");
    expect(interpretationSource("gemini", "gemini-2.5-flash-lite")).toBe("Gemini Flash-Lite");
    expect(interpretationSource("gemini", "gemini-2.5-flash")).toBe("Gemini Flash");
    expect(interpretationSource("rules")).toBe("Rules");
  });
});
