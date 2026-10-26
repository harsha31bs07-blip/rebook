import { describe, expect, it } from "vitest";
import type { Disruption, Plan, State } from "../lib/domain/types";
import { PlanSchema, StateSchema } from "../lib/domain/schemas";
import { addMinutes, DAY, fitsPreferences, fromCents, insideOpenHours, iso, localParts, overlaps, toCents, zonedTimeToUtc } from "../lib/domain/time";
import { seedStudio, demoDisruption, floodDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { applyPlan, feasibilityErrors, validate } from "../lib/solver/validate";
import { defaultWeights, scoreCandidate } from "../lib/solver/score";
import { activateConstraint } from "../lib/solver/constraints";

const now = "2026-11-09T00:00:00.000Z";
const sick: Disruption = { kind: "instructor_unavailable", instructorId: "i1", from: now, to: "2026-11-10T00:00:00.000Z" };
const roomDown: Disruption = { kind: "room_unavailable", roomId: "r1", from: now, to: sick.to };
const closure: Disruption = { kind: "closure", from: now, to: sick.to };

it("enforces active constraints on future placements without invalidating historical sessions", () => {
  const state = activateConstraint(fixture(), sick);
  const disruption: Disruption = { kind: "room_unavailable", roomId: "r1", from: "2026-11-09T11:00:00Z", to: "2026-11-09T12:00:00Z" };
  const plan = replan(state, disruption, { now: "2026-11-09T11:00:00Z" });
  expect(validate(state, plan).ok).toBe(true);
  expect(validate(state, { ...plan, now: "2026-11-09T09:00:00Z" }).ok).toBe(false);
});

function fixture(): State {
  return {
    studio: { id: "studio", name: "Studio", timezone: "UTC", currency: "USD", weekStart: "2026-11-09T00:00:00Z",
      openHours: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ open: "07:00", close: "21:00" }]])) },
    instructors: [
      { id: "i1", name: "One", skills: ["yoga"], maxSessionsPerDay: 3 },
      { id: "i2", name: "Two", skills: ["yoga"], maxSessionsPerDay: 3 },
    ],
    rooms: [
      { id: "r1", name: "One", supports: ["yoga"], capacity: 10 },
      { id: "r2", name: "Two", supports: ["yoga"], capacity: 10 },
    ],
    sessions: [{ id: "s1", title: "Yoga", classType: "yoga", instructorId: "i1", roomId: "r1",
      start: "2026-11-09T10:00:00.000Z", end: "2026-11-09T11:00:00.000Z", capacity: 10, price: "18.00" }],
    customers: Array.from({ length: 3 }, (_, index) => ({
      id: `c${index + 1}`, name: `Customer ${index + 1}`, email: `member${index}@example.com`,
      prefs: { acceptsSubstitute: true, windows: Array.from({ length: 7 }, (_, weekday) => ({ weekday, from: "07:00", to: "21:00" })) },
    })),
    bookings: Array.from({ length: 3 }, (_, index) => ({
      id: `b${index + 1}`, customerId: `c${index + 1}`, sessionId: "s1", status: "confirmed", amount: "18.00",
    })),
  };
}

function expectValid(state: State, plan: Plan) {
  expect(PlanSchema.safeParse(plan).success).toBe(true);
  expect(validate(state, plan)).toEqual({ ok: true, errors: [] });
}

describe("recovery remedies", () => {
  it("substitutes a skilled free instructor at the original time", () => {
    const state = fixture();
    const plan = replan(state, sick, { now });
    expect(plan.sessionChanges[0]).toMatchObject({ remedy: "substitute", after: { instructorId: "i2", start: state.sessions[0].start, roomId: "r1" } });
    expect(plan.totals).toEqual({ sessionsAffected: 1, kept: 3, moved: 0, refunded: 0, refundAmount: "0.00", revenueKept: "54.00" });
    expectValid(state, plan);
  });

  it("moves to a supported room at the original time", () => {
    const state = fixture();
    const plan = replan(state, roomDown, { now });
    expect(plan.sessionChanges[0]).toMatchObject({ remedy: "move_room", after: { roomId: "r2", instructorId: "i1", start: state.sessions[0].start } });
    expectValid(state, plan);
  });

  it("moves time if the original instructor is the only skilled one", () => {
    const state = fixture();
    state.instructors[1].skills = ["spin"];
    const plan = replan(state, sick, { now });
    expect(plan.sessionChanges[0]).toMatchObject({ remedy: "move_time", after: { start: "2026-11-10T10:00:00.000Z", instructorId: "i1" } });
    expect(plan.bookingActions.every((action) => action.action === "move")).toBe(true);
    expectValid(state, plan);
  });

  it("cancels when the entire recovery horizon is closed, with exact refunds", () => {
    const state = fixture();
    const plan = replan(state, { ...closure, to: iso(Date.parse(now) + 8 * DAY) }, { now });
    expect(plan.sessionChanges[0].remedy).toBe("cancel");
    expect(plan.sessionChanges[0].after).toBeUndefined();
    expect(plan.totals.refundAmount).toBe("54.00");
    expect(plan.totals.revenueKept).toBe("0.00");
    expectValid(state, plan);
  });

  it("reserves chosen placements so affected classes cannot collide", () => {
    const state = fixture();
    state.sessions.push({ ...state.sessions[0], id: "s2", start: addMinutes(state.sessions[0].start, 60), end: addMinutes(state.sessions[0].end, 60) });
    state.rooms = [state.rooms[0]];
    const plan = replan(state, closure, { now });
    expect(plan.sessionChanges).toHaveLength(2);
    expect(plan.sessionChanges.every((change) => change.remedy === "move_time")).toBe(true);
    expectValid(state, plan);
  });

  it("closure handles every overlapping upcoming class and ignores historical classes", () => {
    const state = fixture();
    state.sessions.push({ ...state.sessions[0], id: "s2", instructorId: "i2", roomId: "r2" });
    state.sessions.push({ ...state.sessions[0], id: "past", start: "2026-11-08T10:00:00Z", end: "2026-11-08T11:00:00Z" });
    const plan = replan(state, { ...closure, from: "2026-11-08T00:00:00Z" }, { now });
    expect(plan.sessionChanges.map((change) => change.sessionId)).toEqual(["s1", "s2"]);
    expect(plan.sessionChanges.every((change) => change.remedy === "move_time" || change.remedy === "cancel")).toBe(true);
    expectValid(state, plan);
  });

  it("honors substitute skills, occupied resources, individual unavailability and daily limits", () => {
    for (const blocked of ["skill", "unavailable", "limit", "collision"] as const) {
      const state = fixture();
      if (blocked === "skill") state.instructors[1].skills = ["dance"];
      if (blocked === "unavailable") state.instructors[1].unavailability = [{ from: now, to: sick.to }];
      if (blocked === "limit" || blocked === "collision") {
        state.sessions.push({ ...state.sessions[0], id: "busy", instructorId: "i2", roomId: "r2",
          ...(blocked === "limit" ? { start: "2026-11-09T12:00:00Z", end: "2026-11-09T13:00:00Z" } : {}) });
        if (blocked === "limit") state.instructors[1].maxSessionsPerDay = 1;
      }
      const plan = replan(state, sick, { now });
      expect(plan.sessionChanges[0].remedy, blocked).toBe("move_time");
      expectValid(state, plan);
    }
  });

  it("uses configured weights and never takes a non-feasible low-cost remedy", () => {
    const state = fixture();
    const plan = replan(state, sick, { now, weights: { cancel: 0, refund: 0, substitute: 100 } });
    expect(plan.sessionChanges[0].remedy).toBe("cancel");
    expectValid(state, plan);
  });
});

describe("booking decisions", () => {
  it("keeps earliest booking IDs when the replacement room overflows", () => {
    const state = fixture();
    state.rooms[1].capacity = 2;
    state.bookings.reverse();
    const plan = replan(state, roomDown, { now });
    expect(plan.sessionChanges[0].remedy).toBe("move_room");
    expect(plan.bookingActions.map(({ bookingId, action }) => [bookingId, action])).toEqual([["b1", "keep"], ["b2", "keep"], ["b3", "refund"]]);
    expect(applyPlan(state, plan).sessions[0].capacity).toBe(2);
    expectValid(state, plan);
  });

  it("prefers a full room to a smaller room with a lower ID", () => {
    const state = fixture();
    state.rooms.push({ ...state.rooms[1], id: "r3" });
    state.rooms[1].capacity = 1;
    const plan = replan(state, roomDown, { now });
    expect(plan.sessionChanges[0].after?.roomId).toBe("r3");
    expectValid(state, plan);
  });

  it("refunds refundOnly customers and customers who refuse the substitute", () => {
    const state = fixture();
    state.customers[0].prefs.refundOnly = true;
    state.customers[1].prefs.acceptsSubstitute = false;
    state.customers[1].prefs.preferredInstructorIds = ["i1"];
    state.customers[2].prefs.acceptsSubstitute = false;
    state.customers[2].prefs.preferredInstructorIds = ["i1", "i2"];
    const plan = replan(state, sick, { now });
    expect(plan.bookingActions.map((action) => action.action)).toEqual(["refund", "refund", "keep"]);
    expectValid(state, plan);
  });

  it("only moves customers whose entire replacement duration fits their windows", () => {
    const state = fixture();
    state.customers[0].prefs.refundOnly = true;
    state.customers[1].prefs.windows = [{ weekday: 2, from: "10:00", to: "10:30" }];
    const plan = replan(state, closure, { now });
    expect(plan.bookingActions.map((action) => action.action)).toEqual(["refund", "refund", "move"]);
    expectValid(state, plan);
  });

  it("ignores inactive bookings and treats already moved bookings as active", () => {
    const state = fixture();
    state.bookings[0].status = "refunded";
    state.bookings[1].status = "moved";
    const plan = replan(state, sick, { now });
    expect(plan.bookingActions.map((action) => action.bookingId)).toEqual(["b2", "b3"]);
    expectValid(state, plan);
  });

  it("applies statuses without mutating any nested input data", () => {
    const state = fixture();
    state.customers[0].prefs.refundOnly = true;
    const snapshot = structuredClone(state);
    const plan = replan(state, closure, { now });
    const next = applyPlan(state, plan);
    expect(next.bookings.map((booking) => booking.status)).toEqual(["refund_pending", "moved", "moved"]);
    expect(state).toEqual(snapshot);
    next.customers[0].prefs.windows.length = 0;
    expect(state).toEqual(snapshot);
    const kept = applyPlan(fixture(), replan(fixture(), sick, { now }));
    expect(kept.bookings.every((booking) => booking.status === "confirmed")).toBe(true);
  });
});

describe("independent validation", () => {
  it("rejects a hand-made instructor/room double booking", () => {
    const state = fixture();
    state.sessions.push({ ...state.sessions[0], id: "busy", instructorId: "i2", roomId: "r2" });
    const plan = replan(state, sick, { now });
    plan.sessionChanges[0].remedy = "substitute";
    plan.sessionChanges[0].after = { ...plan.sessionChanges[0].before, instructorId: "i2", roomId: "r2" };
    const result = validate(state, plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("double booking"))).toBe(true);
  });

  it("rejects missing and duplicate actions, mismatched money and incorrect totals", () => {
    const state = fixture();
    for (const kind of ["missing", "duplicate", "amount", "totals"] as const) {
      const plan = replan(state, sick, { now });
      if (kind === "missing") plan.bookingActions.pop();
      if (kind === "duplicate") plan.bookingActions.push(plan.bookingActions[0]);
      if (kind === "amount") plan.bookingActions[0].amount = "0.01";
      if (kind === "totals") plan.totals.kept = 0;
      expect(validate(state, plan).ok, kind).toBe(false);
    }
  });

  it("detects unsupported skills/rooms, daily limits, availability, opening hours and capacity", () => {
    const state = fixture();
    const bad = { ...state.sessions[0], instructorId: "i2", roomId: "r2", capacity: 100,
      start: "2026-11-09T03:00:00Z", end: "2026-11-09T04:00:00Z" };
    state.instructors[1].skills = [];
    state.instructors[1].unavailability = [{ from: now, to: sick.to }];
    state.instructors[1].maxSessionsPerDay = 1;
    state.sessions.push({ ...state.sessions[0], id: "other", instructorId: "i2", roomId: "r2" });
    state.rooms[1].supports = [];
    const errors = feasibilityErrors(state, bad, { ...closure });
    for (const fragment of ["skill", "unavailable", "daily limit", "support", "capacity", "open hours", "disrupted resource"]) {
      expect(errors.some((error) => error.includes(fragment)), fragment).toBe(true);
    }
  });
});

describe("seed and determinism", () => {
  it("seeds a realistic local week with valid sessions, preferences and payments", () => {
    const state = seedStudio();
    expect(StateSchema.safeParse(state).success).toBe(true);
    expect([state.sessions.length, state.customers.length, state.instructors.length, state.rooms.length]).toEqual([42, 120, 6, 4]);
    expect(state.customers.filter((customer) => !customer.prefs.acceptsSubstitute)).toHaveLength(6);
    expect(state.customers.filter((customer) => customer.prefs.refundOnly)).toHaveLength(3);
    expect(state.customers.every((customer) => customer.prefs.windows.length >= 2 && customer.prefs.windows.length <= 4)).toBe(true);
    const tz = state.studio.timezone;
    expect(localParts(state.sessions[0].start, tz)).toEqual({ weekday: 1, minutesOfDay: 420, dateKey: "2026-11-09" });
    expect([1, 2, 3, 4, 5, 6, 0].map((weekday) =>
      state.sessions.filter((session) => localParts(session.start, tz).weekday === weekday).length)).toEqual([7, 7, 7, 7, 7, 4, 3]);
    for (const session of state.sessions) {
      const bookings = state.bookings.filter((booking) => booking.sessionId === session.id);
      expect(bookings.length / session.capacity).toBeGreaterThanOrEqual(0.5);
      expect(bookings.length / session.capacity).toBeLessThanOrEqual(0.85);
      expect(["18.00", "22.00", "25.00"]).toContain(session.price);
      const local = localParts(session.start, tz);
      if (local.weekday === 0 || local.weekday === 6) expect(local.minutesOfDay).toBeLessThan(12 * 60);
      else expect((local.minutesOfDay >= 7 * 60 && local.minutesOfDay <= 9.5 * 60) ||
        (local.minutesOfDay >= 12 * 60 && local.minutesOfDay <= 13 * 60) ||
        (local.minutesOfDay >= 17 * 60 && local.minutesOfDay <= 20 * 60)).toBe(true);
      expect(bookings.every((booking) => fitsPreferences(state.customers.find((customer) => customer.id === booking.customerId)!, session.start, session.end, tz))).toBe(true);
    }
    expect(state.bookings.every((booking) => booking.payment?.orderId.startsWith("SEED-ORDER-") && booking.payment.captureId.startsWith("SEED-CAP-"))).toBe(true);
    expect(state.sessions.flatMap((session) => feasibilityErrors(state, session))).toEqual([]);
    expect(seedStudio(42)).toEqual(state);
    expect(seedStudio(43)).not.toEqual(state);
  });

  it("hero disruption accounts for customer conflicts with substitutes and time moves under 200 ms", () => {
    const state = seedStudio();
    const start = performance.now();
    const plan = replan(state, demoDisruption);
    const elapsed = performance.now() - start;
    // Maya has spare slots later in the week, so cancellation does not arise naturally.
    expect(new Set(plan.sessionChanges.map((change) => change.remedy))).toEqual(new Set(["substitute", "move_time"]));
    expect(new Set(plan.bookingActions.map((action) => action.action))).toEqual(new Set(["keep", "move", "refund"]));
    expect(plan.totals.sessionsAffected).toBe(3);
    expect(plan.totals).toEqual({ sessionsAffected: 3, kept: 9, moved: 16, refunded: 6, refundAmount: "135.00", revenueKept: "577.00" });
    const refunds = plan.bookingActions.filter((action) => action.action === "refund");
    expect(refunds.length).toBeGreaterThan(0);
    expect(refunds.every((action) => /requests a refund|instructor is outside|New time does not fit|overlap/.test(action.reason))).toBe(true);
    expect(new Set(refunds.map((action) => action.reason)).size).toBe(4);
    expect(demoDisruption.from).toBe("2026-11-09T05:00:00.000Z");
    expect(demoDisruption.to).toBe("2026-11-10T05:00:00.000Z");
    expectValid(state, plan);
    expect(elapsed).toBeLessThan(200);
    console.info("demoDisruption", JSON.stringify(plan.totals), `${elapsed.toFixed(1)} ms`);
    for (const change of plan.sessionChanges) {
      const session = state.sessions.find((item) => item.id === change.sessionId)!;
      const describePlacement = (placement: typeof change.before) => {
        const time = localParts(placement.start, state.studio.timezone);
        const clock = `${String(Math.floor(time.minutesOfDay / 60)).padStart(2, "0")}:${String(time.minutesOfDay % 60).padStart(2, "0")}`;
        return `${state.instructors.find((item) => item.id === placement.instructorId)!.name}/${state.rooms.find((item) => item.id === placement.roomId)!.name}/${time.dateKey} ${clock}`;
      };
      const actions = plan.bookingActions.filter((action) => state.bookings.find((booking) => booking.id === action.bookingId)!.sessionId === session.id);
      console.info(`${session.title}: ${change.remedy}; ${describePlacement(change.before)} -> ${change.after ? describePlacement(change.after) : "cancelled"}; kept/moved/refunded ${["keep", "move", "refund"].map((kind) => actions.filter((action) => action.action === kind).length).join("/")}`);
    }
  });

  it("recovers Wednesday's flooded room with a valid move_room plan", () => {
    const state = seedStudio();
    const plan = replan(state, floodDisruption);
    expect(floodDisruption.from).toBe("2026-11-11T21:00:00.000Z");
    expect(floodDisruption.to).toBe("2026-11-12T02:00:00.000Z");
    expect(plan.sessionChanges.some((change) => change.remedy === "move_room")).toBe(true);
    expectValid(state, plan);
    console.info("floodDisruption", JSON.stringify(plan.totals));
  });

  it("returns byte-identical plans on repeat calls and reordered state arrays", () => {
    const state = seedStudio();
    const original = structuredClone(state);
    const first = replan(state, demoDisruption);
    const second = replan(state, demoDisruption);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    for (const array of [state.sessions, state.instructors, state.rooms, state.bookings, state.customers]) array.reverse();
    expect(JSON.stringify(replan(state, demoDisruption))).toBe(JSON.stringify(first));
    state.sessions.reverse(); state.instructors.reverse(); state.rooms.reverse(); state.bookings.reverse(); state.customers.reverse();
    expect(state).toEqual(original);
  });
});

describe("time and money boundaries", () => {
  const tz = "America/New_York";

  it("converts local clocks across the November 1 DST fallback", () => {
    expect(zonedTimeToUtc("2026-10-31", "07:00", tz)).toBe("2026-10-31T11:00:00.000Z");
    expect(zonedTimeToUtc("2026-11-01", "07:00", tz)).toBe("2026-11-01T12:00:00.000Z");
    expect(Date.parse(zonedTimeToUtc("2026-11-02", "00:00", tz)) -
      Date.parse(zonedTimeToUtc("2026-11-01", "00:00", tz))).toBe(25 * 60 * 60_000);
    expect(zonedTimeToUtc("2026-11-01", "01:30", tz)).toBe("2026-11-01T05:30:00.000Z");
    for (const instant of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]) {
      expect(localParts(instant, tz)).toEqual({ weekday: 0, minutesOfDay: 90, dateKey: "2026-11-01" });
    }
    expect(zonedTimeToUtc("2026-03-08", "02:30", tz)).toBe("2026-03-08T07:30:00.000Z");
    expect(() => zonedTimeToUtc("2026-02-30", "07:00", tz)).toThrow();
    expect(() => zonedTimeToUtc("2026-11-01", "24:00", tz)).toThrow();
  });

  it("uses local weekday and clock for opening hours and customer windows across UTC midnight", () => {
    const state = fixture();
    state.studio.timezone = tz;
    state.studio.openHours = { 1: [{ open: "17:00", close: "21:00" }] };
    state.customers[0].prefs.windows = [{ weekday: 1, from: "17:00", to: "21:00" }];
    const start = "2026-11-10T00:30:00Z";
    const end = "2026-11-10T01:30:00Z";
    expect(localParts(start, tz)).toEqual({ weekday: 1, minutesOfDay: 1170, dateKey: "2026-11-09" });
    expect(insideOpenHours(state.studio, start, end)).toBe(true);
    expect(fitsPreferences(state.customers[0], start, end, tz)).toBe(true);
    expect(insideOpenHours(state.studio, start, "2026-11-10T02:01:00Z")).toBe(false);
    expect(fitsPreferences(state.customers[0], start, "2026-11-10T02:01:00Z", tz)).toBe(false);
    expect(insideOpenHours(state.studio, "2026-11-09T17:00:00Z", "2026-11-09T18:00:00Z")).toBe(false);
  });

  it("counts daily instructor limits on the local date on either side of UTC midnight", () => {
    const state = fixture();
    state.studio.timezone = tz;
    state.instructors[1].maxSessionsPerDay = 1;
    const candidate = { ...state.sessions[0], instructorId: "i2", start: "2026-11-09T23:00:00Z", end: "2026-11-10T00:00:00Z" };
    state.sessions = [{ ...candidate, id: "busy", roomId: "r2", start: "2026-11-10T01:00:00Z", end: "2026-11-10T02:00:00Z" }];
    expect(feasibilityErrors(state, candidate)).toContain("Instructor daily limit exceeded");
    state.sessions[0].start = "2026-11-10T12:00:00Z";
    state.sessions[0].end = "2026-11-10T13:00:00Z";
    expect(feasibilityErrors(state, candidate)).toEqual([]);
  });

  it("searches studio-local days and preserves the clock time across DST", () => {
    const state = fixture();
    state.studio.timezone = tz;
    state.instructors = [state.instructors[0]];
    state.sessions[0].start = zonedTimeToUtc("2026-10-31", "07:00", tz);
    state.sessions[0].end = addMinutes(state.sessions[0].start, 60);
    for (const customer of state.customers) customer.prefs.windows = [{ weekday: 0, from: "07:00", to: "09:00" }];
    const disruption: Disruption = { kind: "instructor_unavailable", instructorId: "i1",
      from: zonedTimeToUtc("2026-10-31", "00:00", tz), to: zonedTimeToUtc("2026-11-01", "00:00", tz) };
    const plan = replan(state, disruption, { now: disruption.from, horizonDays: 2 });
    expect(plan.sessionChanges[0]).toMatchObject({ remedy: "move_time", after: { start: "2026-11-01T12:00:00.000Z" } });
    expect(plan.totals.moved).toBe(3);
    expectValid(state, plan);
  });

  it("scores the same local weekday and clock equally across a DST offset change", () => {
    const before = fixture().sessions[0];
    before.start = zonedTimeToUtc("2026-10-25", "19:00", tz);
    before.end = addMinutes(before.start, 60);
    const after = { ...before, start: zonedTimeToUtc("2026-11-01", "19:00", tz) };
    after.end = addMinutes(after.start, 60);
    expect(scoreCandidate("move_time", before, after, [], { ...defaultWeights, delay: 0 }, tz)).toBe(defaultWeights.moveTime);
    after.start = zonedTimeToUtc("2026-11-02", "19:00", tz);
    expect(scoreCandidate("move_time", before, after, [], { ...defaultWeights, delay: 0 }, tz)).toBe(defaultWeights.moveTime + defaultWeights.weekdayChange);
  });
  it("prefers next-day recovery over later days and next week's same weekday", () => {
    const before = fixture().sessions[0];
    const score = (days: number) => scoreCandidate("move_time", before,
      { ...before, start: iso(Date.parse(before.start) + days * DAY), end: iso(Date.parse(before.end) + days * DAY) },
      [], defaultWeights, "UTC");
    expect(score(1)).toBeLessThan(score(2));
    expect(score(2)).toBeLessThan(score(7));
    expect(score(2) - score(1)).toBe(40);
  });

  it("uses half-open intervals and normalizes ISO offsets", () => {
    expect(overlaps("2026-11-09T10:00:00Z", "2026-11-09T11:00:00Z", "2026-11-09T11:00:00Z", "2026-11-09T12:00:00Z")).toBe(false);
    expect(iso("2026-11-09T00:00:00-05:00")).toBe("2026-11-09T05:00:00.000Z");
    expect(iso(Date.parse(now) + DAY)).toBe(sick.to);
  });

  it("computes decimal amounts with integer cents", () => {
    expect(fromCents(3 * toCents("18.00"))).toBe("54.00");
    expect(fromCents(toCents("0.10") + toCents("0.20"))).toBe("0.30");
    expect(() => toCents("18.1")).toThrow();
    expect(() => fromCents(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it("finds resource boundaries that fall between quarter-hour slots", () => {
    const state = fixture();
    const disruption = { ...closure, to: "2026-11-09T10:07:00Z" };
    const plan = replan(state, disruption, { now, horizonDays: 1,
      weights: { timeShift: 0, weekdayChange: 0, delay: 1 } });
    expect(plan.sessionChanges[0].after?.start).toBe("2026-11-09T10:07:00.000Z");
    expectValid(state, plan);
  });

  it("handles empty state and invalid options deterministically", () => {
    const state = fixture();
    state.sessions = []; state.bookings = [];
    expectValid(state, replan(state, sick));
    expect(() => replan(state, sick, { horizonDays: -1 })).toThrow();
    expect(() => replan(state, { ...sick, to: now })).toThrow();
  });

  it("honors split opening hours and a horizon that is too short", () => {
    const state = fixture();
    state.studio.openHours = { 1: [{ open: "07:00", close: "09:00" }, { open: "12:00", close: "14:00" }] };
    state.sessions[0].start = "2026-11-09T12:00:00Z";
    state.sessions[0].end = "2026-11-09T13:00:00Z";
    const plan = replan(state, closure, { now, horizonDays: 1 });
    expect(plan.sessionChanges[0].remedy).toBe("cancel");
    expectValid(state, plan);
  });

  it("searches exact customer preference boundaries between grid slots", () => {
    const state = fixture();
    for (const customer of state.customers) customer.prefs.windows = [{ weekday: 2, from: "09:07", to: "10:07" }];
    const plan = replan(state, closure, { now });
    expect(plan.sessionChanges[0].after?.start).toBe("2026-11-10T09:07:00.000Z");
    expect(plan.totals.moved).toBe(3);
    expectValid(state, plan);
  });
});
