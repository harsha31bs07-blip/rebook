import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST as adjust } from "../app/api/workspaces/[id]/plans/[planId]/adjust/route";
import { POST as approve } from "../app/api/workspaces/[id]/plans/[planId]/approve/route";
import { closeRepository, getRepository, type StoredPlan } from "../lib/store";
import { limits } from "../lib/api/limits";
import { replan } from "../lib/solver/replan";
import { validate } from "../lib/solver/validate";
import { activateConstraint } from "../lib/solver/constraints";
import { adjustmentFixture, disruption } from "./adjust-fixture";

let directory: string, id: string, original: StoredPlan;
const request = (body: unknown) => new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const context = () => ({ params: Promise.resolve({ id, planId: original.id }) });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rebook-adjust-"));
  vi.stubEnv("DATA_DIR", directory); vi.stubEnv("DEMO_REAL_CAPTURES", "0"); limits.reset();
  const repository = getRepository();
  const state = adjustmentFixture();
  id = repository.createWorkspace(state).id;
  original = repository.createPlan(id, replan(state, disruption, { now: "2026-11-09T00:00:00Z" }));
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it("recomputes preference actions and totals and leaves the live schedule untouched", async () => {
  const before = getRepository().requireWorkspace(id).state;
  expect(original.totals).toMatchObject({ kept: 2, moved: 0, refunded: 1 });
  const response = await adjust(request({ sessionId: "s1", start: "2026-11-09T14:00:00Z", version: 1 }), context());
  expect(response.status).toBe(200);
  const plan = await response.json();
  expect(plan).not.toHaveProperty("basis"); expect(plan.version).toBe(2);
  expect(plan.sessionChanges[0]).toMatchObject({ ownerAdjusted: true, after: { start: "2026-11-09T14:00:00.000Z", end: "2026-11-09T15:00:00.000Z" } });
  expect(plan.bookingActions.map((item: { action: string }) => item.action)).toEqual(["refund", "move", "refund"]);
  expect(plan.totals).toMatchObject({ kept: 0, moved: 1, refunded: 2, revenueKept: "18.00", refundAmount: "36.00" });
  expect(validate(before, plan).ok).toBe(true);
  expect(getRepository().requireWorkspace(id).state).toEqual(before);
  expect(getRepository().listLedger(id)).toEqual([]);
});

it("returns a clear 422 reason for a collision without saving or bumping the version", async () => {
  const response = await adjust(request({ sessionId: "s1", start: "2026-11-09T12:15:00Z", version: 1 }), context());
  expect(response.status).toBe(422); expect((await response.json()).error).toContain("Alex already teaches at 12:15");
  expect(getRepository().getPlan(id, original.id)).toEqual(original);
});

it.each([
  { sessionId: "s2", start: "2026-11-09T14:00:00Z" },
  { sessionId: "s1", start: "2026-11-16T10:00:00Z" },
  { sessionId: "s1", start: "2026-11-09T06:00:00Z" },
  { sessionId: "s1", start: "2026-11-09T10:00:00Z", instructorId: "i3" },
])("rejects untouched blocks, outside-week, closed-hour and unskilled adjustments: %o", async (input) => {
  expect((await adjust(request({ ...input, version: 1 }), context())).status).toBe(422);
});

it("re-derives capacity refunds for a room move", async () => {
  const response = await adjust(request({ sessionId: "s1", start: "2026-11-09T10:00:00Z", roomId: "r2", version: 1 }), context());
  expect(response.status).toBe(200);
  const plan = await response.json();
  expect(plan.totals).toMatchObject({ kept: 1, refunded: 2 });
  expect(plan.warnings).toEqual(["Yoga: replacement capacity is 1."]);
});

it("enforces new active constraints and validates the whole plan, including untouched sessions", async () => {
  const repository = getRepository();
  const state = repository.requireWorkspace(id).state;
  repository.saveState(id, activateConstraint(state, { kind: "room_unavailable", roomId: "r2", from: "2026-11-09T14:00:00Z", to: "2026-11-09T15:00:00Z" }));
  expect((await adjust(request({ sessionId: "s1", start: "2026-11-09T14:00:00Z", roomId: "r2", version: 1 }), context())).status).toBe(422);
  state.sessions.push({ ...state.sessions[1], id: "collision" }); repository.saveState(id, state);
  const response = await adjust(request({ sessionId: "s1", start: "2026-11-09T14:00:00Z", version: 1 }), context());
  expect(response.status).toBe(422); expect((await response.json()).error).toContain("double booking");
});

it("rejects stale adjustments/approvals, including omitted versions, and approves the persisted adjusted plan", async () => {
  const repository = getRepository();
  const state = repository.requireWorkspace(id).state;
  for (const booking of state.bookings) {
    booking.payment = { orderId: `order-${booking.id}`, captureId: `capture-${booking.id}`, simulated: true };
    repository.appendLedger({ workspaceId: id, bookingId: booking.id, kind: "capture", amount: booking.amount,
      paypalId: booking.payment.captureId, captureId: booking.payment.captureId, requestId: `capture:${booking.id}`, status: "SIMULATED" });
  }
  repository.saveState(id, state);
  const input = { sessionId: "s1", start: "2026-11-10T14:00:00Z", instructorId: "i1", version: 1 };
  expect((await adjust(request(input), context())).status).toBe(200);
  expect((await adjust(request(input), context())).status).toBe(409);
  expect((await approve(request({ version: 1 }), context())).status).toBe(409);
  expect((await approve(request({}), context())).status).toBe(409);
  const response = await approve(request({ version: 2 }), context());
  expect(response.status).toBe(200);
  expect((await response.json()).plan.status).toBe("executed");
  expect(getRepository().requireWorkspace(id).state.sessions.find((item) => item.id === "s1")).toMatchObject({ start: "2026-11-10T14:00:00.000Z", instructorId: "i1" });
  expect((await adjust(request({ ...input, version: 2 }), context())).status).toBe(409);
});

it("undo restores the last placement, actions, totals and badge state while advancing the version", async () => {
  await adjust(request({ sessionId: "s1", start: "2026-11-09T10:00:00Z", roomId: "r2", version: 1 }), context());
  const response = await adjust(request({ undo: true, version: 2 }), context());
  expect(response.status).toBe(200);
  const plan = await response.json();
  expect(plan.version).toBe(3); expect(plan.lastAdjustment).toBeUndefined();
  expect(plan.sessionChanges).toEqual(original.sessionChanges); expect(plan.bookingActions).toEqual(original.bookingActions);
  expect(plan.totals).toEqual(original.totals); expect(plan.warnings).toEqual(original.warnings);
  expect((await adjust(request({ undo: true, version: 3 }), context())).status).toBe(422);
});
