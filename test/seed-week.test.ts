import { describe, expect, it } from "vitest";
import { demoDisruption, demoDisruptionFor, floodDisruption, floodDisruptionFor, nextWeekStart, seedStudio } from "../lib/seed/seed";
import { localParts } from "../lib/domain/time";
import { replan } from "../lib/solver/replan";
import { validate } from "../lib/solver/validate";

const tz = "America/New_York";
describe("seeded demo weeks", () => {
  it.each([
    ["2026-10-19", "2026-10-26"], ["2026-10-20", "2026-10-26"],
    ["2026-10-21", "2026-10-26"], ["2026-10-22", "2026-10-26"],
    ["2026-10-23", "2026-10-26"], ["2026-10-24", "2026-10-26"],
    ["2026-10-25", "2026-10-26"],
  ])("finds next Monday from %s", (today, monday) => {
    expect(localParts(nextWeekStart(`${today}T15:00:00Z`, tz), tz)).toEqual({ dateKey: monday, weekday: 1, minutesOfDay: 0 });
  });
  it("uses the local date and crosses the November DST boundary", () => {
    expect(nextWeekStart("2026-11-01T04:30:00Z", tz)).toBe("2026-11-02T05:00:00.000Z");
    expect(nextWeekStart("2026-11-01T06:30:00Z", tz)).toBe("2026-11-02T05:00:00.000Z");
    expect(nextWeekStart("2026-11-02T02:00:00Z", tz)).toBe("2026-11-02T05:00:00.000Z");
    expect(nextWeekStart("2026-11-02T05:00:00Z", tz)).toBe("2026-11-09T05:00:00.000Z");
  });
  it("preserves the November fixtures and hero totals", () => {
    const week = "2026-11-09T05:00:00Z";
    expect(demoDisruptionFor(week, tz)).toEqual(demoDisruption);
    expect(floodDisruptionFor(week, tz)).toEqual(floodDisruption);
    expect(replan(seedStudio(), demoDisruption).totals).toEqual({ sessionsAffected: 3, kept: 10, moved: 17, refunded: 5, revenueKept: "621.00", refundAmount: "113.00" });
  });
  it.each(["2026-12-07T05:00:00Z", "2026-12-14T05:00:00Z"])("keeps the December hero scenario viable for %s", (week) => {
    const state = seedStudio(42, week);
    const plan = replan(state, demoDisruptionFor(week, tz), { now: "2026-12-01T15:00:00Z", horizonDays: Math.ceil((Date.parse(week) - Date.parse("2026-12-01T15:00:00Z")) / 86400000) + 14 });
    expect(plan.totals.sessionsAffected).toBe(3);
    expect(new Set(plan.bookingActions.map(({ action }) => action))).toEqual(new Set(["keep", "move", "refund"]));
    expect(plan.totals.refunded).toBeLessThanOrEqual(plan.bookingActions.length * 0.25);
    expect(validate(state, plan).ok).toBe(true);
  });
});
