import { expect, it } from "vitest";
import { adjustmentFixture, disruption } from "./adjust-fixture";
import { adjustPlan } from "../lib/solver/adjust";
import { replan } from "../lib/solver/replan";
import { applyPlan, validate } from "../lib/solver/validate";
import { calculateTotals } from "../lib/solver/score";

const now = "2026-11-09T00:00:00Z";
const start = "2026-11-10T10:00:00.000Z";
const end = "2026-11-10T11:00:00.000Z";
function fixture() {
  const state = adjustmentFixture();
  state.rooms[1].capacity = 10;
  state.sessions[1] = { ...state.sessions[1], start, end, roomId: "r2" };
  state.bookings.push({ id: "busy", customerId: "c2", sessionId: "s2", status: "confirmed", amount: "18.00" });
  return state;
}

it("refunds a conflicting moved booking while preserving the customer's unaffected class", () => {
  const state = fixture();
  const plan = replan(state, disruption, { now });
  const next = adjustPlan(state, plan, { sessionId: "s1", start, instructorId: "i1", roomId: "r1" });
  expect(next.bookingActions.find((item) => item.bookingId === "b2")).toMatchObject({ action: "refund", reason: expect.stringContaining("overlap") });
  expect(applyPlan(state, next).bookings.find((item) => item.id === "busy")?.status).toBe("confirmed");
  expect(validate(state, next)).toEqual({ ok: true, errors: [] });
});

it("scores alternative placements against the customer's actual calendar", () => {
  const state = fixture();
  const plan = replan(state, { kind: "closure", from: now, to: "2026-11-10T00:00:00Z" }, { now, weights: { refund: 0 } });
  const after = plan.sessionChanges[0].after!;
  expect(Date.parse(after.start) >= Date.parse(end) || Date.parse(after.end) <= Date.parse(start)).toBe(true);
  expect(plan.bookingActions.find((item) => item.bookingId === "b2")?.action).toBe("move");
  expect(validate(state, plan).ok).toBe(true);
});

it("rejects a forged retained booking that overlaps another class, even with consistent totals", () => {
  const state = fixture();
  const plan = adjustPlan(state, replan(state, disruption, { now }), { sessionId: "s1", start, instructorId: "i1" });
  plan.bookingActions.find((item) => item.bookingId === "b2")!.action = "move";
  plan.totals = calculateTotals(plan.sessionChanges.length, plan.bookingActions);
  expect(validate(state, plan).ok).toBe(false);
});

it("recomputes both affected classes deterministically after an owner adjustment", () => {
  const state = fixture();
  // Both classes begin Monday, using independent resources and the same customer.
  state.sessions[1].start = "2026-11-09T12:00:00.000Z";
  state.sessions[1].end = "2026-11-09T13:00:00.000Z";
  const closure = { kind: "closure" as const, from: now, to: "2026-11-10T00:00:00Z" };
  const plan = replan(state, closure, { now });
  const first = adjustPlan(state, plan, { sessionId: "s1", start, instructorId: "i1", roomId: "r1" });
  const next = adjustPlan(state, first, { sessionId: "s2", start, instructorId: "i2", roomId: "r2" });
  expect(next.bookingActions.find((item) => item.bookingId === "b2")?.action).toBe("move");
  expect(next.bookingActions.find((item) => item.bookingId === "busy")?.action).toBe("refund");
  const shuffled = { ...state, sessions: [...state.sessions].reverse(), bookings: [...state.bookings].reverse() };
  expect(adjustPlan(shuffled, first, { sessionId: "s2", start, instructorId: "i2", roomId: "r2" }).bookingActions).toEqual(next.bookingActions);
  expect(validate(state, next).ok).toBe(true);
});

it("does not treat refunded bookings or adjacent classes as a conflict", () => {
  for (const adjacent of [false, true]) {
    const state = fixture();
    if (adjacent) { state.sessions[1].start = end; state.sessions[1].end = "2026-11-10T12:00:00.000Z"; }
    else state.bookings.find((item) => item.id === "busy")!.status = "refunded";
    const plan = adjustPlan(state, replan(state, disruption, { now }), { sessionId: "s1", start, instructorId: "i1" });
    expect(plan.bookingActions.find((item) => item.bookingId === "b2")?.action).toBe("move");
    expect(validate(state, plan).ok).toBe(true);
  }
});

it("preserves existing customer overlaps when neither class changes time", () => {
  const state = fixture();
  state.instructors.push({ id: "i4", name: "Cover", skills: ["yoga"], maxSessionsPerDay: 3 });
  state.sessions[1].start = state.sessions[0].start;
  state.sessions[1].end = state.sessions[0].end;
  const plan = replan(state, disruption, { now });
  expect(plan.sessionChanges[0].remedy).toBe("substitute");
  expect(plan.bookingActions.find((item) => item.bookingId === "b2")?.action).toBe("keep");
  expect(validate(state, plan).ok).toBe(true);
});
