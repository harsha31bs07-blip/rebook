import { expect, it } from "vitest";
import { adjustmentFixture, disruption } from "./adjust-fixture";
import { replan } from "../lib/solver/replan";
import { planCorrection } from "../lib/solver/correction";
import { activateConstraint } from "../lib/solver/constraints";
import { applyPlan, validate } from "../lib/solver/validate";
import { adjustPlan, checkAdjustment } from "../lib/solver/adjust";
import { mapSchedule } from "../lib/client/scheduler-mapping";

function fixture() {
  const basis = adjustmentFixture();
  const recovery = { ...replan(basis, disruption, { now: "2026-11-09T00:00:00Z" }), id: "original", basis };
  const state = activateConstraint(applyPlan(basis, recovery), disruption);
  const correction = planCorrection(state, recovery, "2026-11-09T09:00:00Z");
  return { state, correction };
}

it("checks restored placements with only the withdrawn disruption deactivated", () => {
  const { state, correction } = fixture();
  const input = { sessionId: "s1", start: "2026-11-09T14:00:00Z" };
  expect(checkAdjustment(state, correction, input)).toMatchObject({ valid: true, message: "", session: { instructorId: "i1" } });
  const adjusted = adjustPlan(state, correction, input);
  expect(validate(state, adjusted)).toEqual({ ok: true, errors: [] });
  expect(adjusted.bookingActions.map((action) => action.action)).toEqual(["move", "move"]);
  expect(adjusted.totals).toMatchObject({ kept: 0, moved: 2, refunded: 0, revenueKept: "36.00", refundAmount: "0.00" });
  const blocked = activateConstraint(state, { kind: "room_unavailable", roomId: "r1", from: input.start, to: "2026-11-09T15:00:00Z" });
  expect(checkAdjustment(blocked, correction, input)).toMatchObject({ valid: false, message: "Session overlaps disrupted resource" });
});

it.each([
  [{ sessionId: "s1", start: "2026-11-09T08:00:00Z" }, "past"],
  [{ sessionId: "s1", start: "2026-11-16T10:00:00Z" }, "studio week"],
  [{ sessionId: "s1", start: "2026-11-09T12:15:00Z", instructorId: "i2" }, "Alex already teaches at 12:15 PM."],
  [{ sessionId: "s1", start: "2026-11-09T14:00:00Z", instructorId: "i3" }, "lacks class skill"],
  [{ sessionId: "s1", start: "2026-11-09T14:00:00Z", roomId: "r2" }, "Choose a larger room"],
  [{ sessionId: "s1", start: "invalid" }, "valid start"],
] as const)("rejects an invalid correction placement %o", (input, reason) => {
  const { state, correction } = fixture();
  const checked = checkAdjustment(state, correction, input);
  expect(checked.valid).toBe(false); expect(checked.message).toContain(reason);
  expect(checked.message).not.toContain("Discard it");
  expect(() => adjustPlan(state, correction, input)).toThrow(reason);
});

it("rejects customer overlaps in the drag pre-check and server adjustment without refunding or moving their other booking", () => {
  const { state, correction } = fixture();
  state.rooms.push({ ...state.rooms[0], id: "r3" });
  state.bookings.push({ ...state.bookings[1], id: "other-booking", sessionId: "s2" });
  const input = { sessionId: "s1", start: "2026-11-09T12:15:00Z", roomId: "r3" };
  const before = structuredClone(state);
  expect(checkAdjustment(state, correction, input)).toMatchObject({ valid: false, message: "Flexible has another class then. Choose another time." });
  expect(() => adjustPlan(state, correction, input)).toThrow("Flexible has another class then. Choose another time.");
  expect(state).toEqual(before);
});

it("computes room, instructor and unchanged-placement remedies relative to the current session", () => {
  const { state, correction } = fixture();
  state.rooms.push({ ...state.rooms[0], id: "r3" });
  for (const [input, remedy] of [
    [{ roomId: "r3" }, "move_room"],
    [{ instructorId: "i2" }, "substitute"],
    [{ roomId: "r3", instructorId: "i2" }, "move_room"],
  ] as const) {
    const adjusted = adjustPlan(state, correction, { sessionId: "s1", start: "2026-11-09T10:00:00Z", ...input });
    expect(adjusted.sessionChanges[0]).toMatchObject({ remedy, ownerAdjusted: true });
    expect(validate(state, adjusted)).toEqual({ ok: true, errors: [] });
    const recovery = { ...adjusted, correctionOf: undefined };
    if (input.instructorId === "i2" && !input.roomId) expect(validate(state, recovery).errors).toContain("Invalid substitute remedy: s1");
  }
});

it("maps only restored blocks as draggable in both row modes and keeps stay classes fixed", () => {
  const { state, correction } = fixture();
  for (const mode of ["instructors", "rooms"] as const) {
    const mapped = mapSchedule(state, mode, correction);
    expect(mapped.events.filter((event) => event.draggable).map((event) => event.id)).toEqual(["s1-new"]);
    expect(mapped.events.find((event) => event.id === "s2")?.draggable).toBe(false);
  }
});
