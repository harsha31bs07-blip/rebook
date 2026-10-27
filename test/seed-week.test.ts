import { describe, expect, it } from "vitest";
import { demoDisruption, demoDisruptionFor, floodDisruption, floodDisruptionFor, nextWeekStart, seedStudio } from "../lib/seed/seed";
import { addLocalDays, localParts, overlaps, toCents, zonedTimeToUtc } from "../lib/domain/time";
import type { State } from "../lib/domain/types";
import { replan } from "../lib/solver/replan";
import { applyPlan, validate } from "../lib/solver/validate";
import { realCaptureBookingIds } from "../lib/demo/createWorkspace";

const tz = "America/New_York";
const heroTotals = { sessionsAffected: 3, kept: 9, moved: 16, refunded: 6, revenueKept: "577.00", refundAmount: "135.00" };
function expectNoCustomerOverlaps(state: State) {
  for (const customer of state.customers) {
    const sessions = state.bookings.filter((booking) => booking.customerId === customer.id && ["confirmed", "moved"].includes(booking.status))
      .map((booking) => state.sessions.find((session) => session.id === booking.sessionId)!);
    sessions.forEach((session, index) => sessions.slice(index + 1).forEach((other) => {
      expect(overlaps(session.start, session.end, other.start, other.end), `${customer.id}: ${session.id}/${other.id}`).toBe(false);
    }));
  }
}
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
    expect(replan(seedStudio(), demoDisruption).totals).toEqual(heroTotals);
  });
  it.each([
    nextWeekStart("2026-10-26T15:00:00Z", tz),
    nextWeekStart(new Date().toISOString(), tz),
    "2026-10-26T04:00:00Z", "2026-11-09T05:00:00Z",
    "2026-12-07T05:00:00Z", "2026-12-14T05:00:00Z",
  ])("recovers a strong, honest hero within %s", (week) => {
    const state = seedStudio(42, week);
    const startKey = localParts(week, tz).dateKey;
    const horizonEnd = zonedTimeToUtc(addLocalDays(startKey, 7), "00:00", tz);
    const options = { now: zonedTimeToUtc(addLocalDays(startKey, -1), "12:00", tz), horizonEnd };
    const plan = replan(state, demoDisruptionFor(week, tz), options);
    for (const change of plan.sessionChanges) {
      expect(Date.parse(change.after!.start)).toBeGreaterThanOrEqual(Date.parse(week));
      expect(Date.parse(change.after!.end)).toBeLessThanOrEqual(Date.parse(horizonEnd));
      if (change.remedy === "move_time") {
        expect(localParts(change.after!.start, tz)).toEqual({
          dateKey: addLocalDays(startKey, 1), weekday: 2, minutesOfDay: localParts(change.before.start, tz).minutesOfDay,
        });
      }
    }
    expect(plan.sessionChanges[0]).toMatchObject({ remedy: "substitute", after: { instructorId: "instructor-02", start: state.sessions[0].start } });
    expect(plan.totals).toEqual(heroTotals);
    expect(new Set(plan.sessionChanges.map(({ remedy }) => remedy))).toEqual(new Set(["substitute", "move_time"]));
    expect(new Set(plan.bookingActions.map(({ action }) => action))).toEqual(new Set(["keep", "move", "refund"]));
    expect((plan.totals.kept + plan.totals.moved) / plan.bookingActions.length).toBeGreaterThanOrEqual(0.75);
    expect(toCents(plan.totals.revenueKept)).toBeGreaterThanOrEqual(3 * toCents(plan.totals.refundAmount));
    const refunds = plan.bookingActions.filter(({ action }) => action === "refund");
    expect(refunds.reduce<Record<string, number>>((counts, { reason }) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }), {})).toEqual({
      "Prefers a refund after a disruption.": 2,
      "New time does not fit the customer's availability.": 2,
      "Only books with Maya Chen; the replacement instructor is not accepted.": 1,
      "Recovery would overlap the customer's other class; refund the booking.": 1,
    });
    expect(refunds.map(({ customerId }) => state.customers.find(({ id }) => id === customerId)!.name).sort()).toEqual([
      "Avery Brooks", "Gray Brooks", "Harper Brooks", "Indigo Brooks", "Taylor Brooks", "Uma Brooks",
    ]);
    const captures = realCaptureBookingIds(state).size;
    console.info(`hero ${startKey}`, JSON.stringify({ ...plan.totals,
      classes: state.sessions.length, members: state.customers.length, captures }));
    expect(state.sessions).toHaveLength(42);
    expect(state.customers).toHaveLength(120);
    expect(captures).toBe(38);
    expect(captures).toBeLessThanOrEqual(45);
    expect(validate(state, plan)).toEqual({ ok: true, errors: [] });
    expectNoCustomerOverlaps(state);
    expectNoCustomerOverlaps(applyPlan(state, plan));
    const attendance = state.customers.map(({ id }) => state.bookings.filter((booking) => booking.customerId === id).length);
    expect(attendance.every((count) => count >= 1 && count <= 5)).toBe(true);
    expect(attendance.filter((count) => count <= 3).length).toBeGreaterThanOrEqual(state.customers.length * 0.9);
    expect(attendance.filter((count) => count >= 4).length).toBeGreaterThan(0);
    console.info("weekly attendance", attendance.reduce<Record<number, number>>((counts, visits) => ({ ...counts, [visits]: (counts[visits] ?? 0) + 1 }), {}));
    for (const session of state.sessions) {
      const occupancy = state.bookings.filter((booking) => booking.sessionId === session.id).length / session.capacity;
      expect(occupancy, session.id).toBeGreaterThanOrEqual(0.5);
      expect(occupancy).toBeLessThanOrEqual(0.85);
    }
    const flood = replan(state, floodDisruptionFor(week, tz), options);
    expect(flood.totals).toEqual({ sessionsAffected: 1, kept: 7, moved: 0, refunded: 0, refundAmount: "0.00", revenueKept: "126.00" });
    expect(flood.totals.sessionsAffected).toBeGreaterThanOrEqual(1);
    expect(flood.sessionChanges.some(({ remedy }) => remedy === "move_room")).toBe(true);
    const saturday = addLocalDays(startKey, 5);
    const closure = replan(state, { kind: "closure", from: zonedTimeToUtc(saturday, "00:00", tz), to: zonedTimeToUtc(addLocalDays(saturday, 1), "00:00", tz) }, options);
    expect(closure.totals).toEqual({ sessionsAffected: 4, kept: 0, moved: 18, refunded: 7, refundAmount: "126.00", revenueKept: "372.00" });
    expect(closure.totals.sessionsAffected).toBe(4);
    expect(closure.sessionChanges.some(({ remedy }) => remedy === "move_time")).toBe(true);
    expect(closure.totals.moved).toBeGreaterThan(0);
    console.info("flood / closure", JSON.stringify({ flood: flood.totals, closure: closure.totals }));
    for (const other of [flood, closure]) {
      expect(validate(state, other)).toEqual({ ok: true, errors: [] });
      expectNoCustomerOverlaps(applyPlan(state, other));
    }
  });
});
