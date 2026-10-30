import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { planCorrection, samePlacement } from "../lib/solver/correction";
import { activeConstraints, deactivateConstraint } from "../lib/solver/constraints";
import { validate } from "../lib/solver/validate";
import { adjustPlan, checkAdjustment } from "../lib/solver/adjust";
import { explainPlan } from "../lib/ai/explain";
import { executePlan } from "../lib/executor/executePlan";
import { withdrawPlan } from "../lib/recovery/correction";
import { coverView, ownerCovers, payCover, respondToCover } from "../lib/recovery/cover-pay";
import { customerChoice, submitChoice } from "../lib/choices/service";
import { limits } from "../lib/api/limits";
import { POST as withdraw } from "../app/api/workspaces/[id]/plans/[planId]/withdraw/route";
import { POST as approve } from "../app/api/workspaces/[id]/plans/[planId]/approve/route";
import { POST as adjust } from "../app/api/workspaces/[id]/plans/[planId]/adjust/route";
import { setSdkTransport } from "./paypalTransport";

let directory: string, repository: Repository;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rebook-correction-"));
  vi.stubEnv("DATA_DIR", directory); vi.stubEnv("PAYPAL_PAYOUT_RECEIVER", "sandbox@example.com");
  repository = getRepository(); limits.reset();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Correction must not call PayPal"); }));
  setSdkTransport(async () => { throw new Error("Correction must not call PayPal"); });
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function approved(missingCapture = false) {
  const state = seedStudio();
  for (const booking of state.bookings) booking.payment!.simulated = true;
  const { id } = repository.createWorkspace(state);
  const proposed = replan(state, demoDisruption);
  const failed = missingCapture ? proposed.bookingActions.find((action) => action.action === "refund")!.bookingId : undefined;
  for (const booking of state.bookings.filter((item) => item.id !== failed)) repository.appendLedger({ workspaceId: id, bookingId: booking.id, kind: "capture", amount: booking.amount,
    paypalId: booking.payment!.captureId, captureId: booking.payment!.captureId, requestId: `capture:${booking.id}`, status: "SIMULATED" });
  const plan = repository.createPlan(id, proposed);
  const result = await executePlan(id, plan.id, repository);
  return { id, original: result.plan, state };
}
function post(id: string, planId: string, origin = "http://localhost") {
  return withdraw(new Request(`http://localhost/api/workspaces/${id}/plans/${planId}/withdraw`, {
    method: "POST", headers: { origin, "Content-Type": "application/json" }, body: "{}",
  }), { params: Promise.resolve({ id, planId }) });
}

it("previews and approves the hero correction, preserving refunds, superseding choices and closing unpaid covers", async () => {
  const { id, original, state } = await approved();
  expect(original.totals).toMatchObject({ kept: 9, moved: 16, refunded: 6, revenueKept: "577.00", refundAmount: "135.00" });
  const oldLinks = repository.listCustomerLinks(id);
  const cover = ownerCovers(id, repository)[0], token = cover.path.slice(3);
  await respondToCover(token, "accept", repository);
  const before = repository.requireWorkspace(id).state, ledger = repository.listLedger(id);
  const response = await post(id, original.id);
  expect(response.status).toBe(200);
  const correction = await response.json();
  expect(correction).toMatchObject({ status: "proposed", correctionOf: original.id, disruption: original.disruption });
  expect(repository.requireWorkspace(id).state).toEqual(before);
  expect(correction.sessionChanges).toHaveLength(original.sessionChanges.filter((change) => change.after).length);
  expect(validate(deactivateConstraint(before, original.disruption), correction)).toEqual({ ok: true, errors: [] });
  const invalid = structuredClone(correction);
  invalid.bookingActions[0].action = "refund";
  expect(validate(before, invalid).ok).toBe(false);
  expect(correction.totals).toMatchObject({ kept: 9, moved: 16, refunded: 0, refundAmount: "0.00" });
  expect(correction.warnings.join(" ")).toContain("6 refunds already issued stay refunded");
  expect(planCorrection(before, original, correction.now)).toEqual(expect.objectContaining({ sessionChanges: correction.sessionChanges, bookingActions: correction.bookingActions }));
  const result = await approve(new Request("http://localhost/approve", { method: "POST", body: JSON.stringify({ version: 1 }) }),
    { params: Promise.resolve({ id, planId: correction.id }) });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ plan: { status: "executed" }, results: [] });
  const restored = repository.requireWorkspace(id).state;
  expect(activeConstraints(restored)).toEqual([]);
  for (const change of original.sessionChanges.filter((change) => change.after)) {
    expect(samePlacement(restored.sessions.find((session) => session.id === change.sessionId)!, change.before)).toBe(true);
  }
  expect(restored.sessions).toEqual(state.sessions);
  expect(restored.bookings.filter((booking) => booking.status === "refunded")).toHaveLength(6);
  expect(repository.listLedger(id)).toEqual(ledger);
  expect(repository.getPlan(id, original.id)?.correctedBy).toBe(correction.id);
  const links = repository.listCustomerLinks(id).filter((link) => link.planId === correction.id);
  expect(links).toHaveLength(25);
  expect(links.every((link) => link.message.body.includes("Good news:") && !link.message.body.includes("Reply for a refund"))).toBe(true);
  expect(links.some((link) => link.message.body.includes("back at its original time") && link.message.body.includes("with Maya Chen."))).toBe(true);
  expect(links.some((link) => link.message.body.includes("Maya Chen is teaching your Yoga Flow class again at its usual time."))).toBe(true);
  const old = oldLinks.find((link) => link.kind === "choice")!;
  expect(await customerChoice(repository.customerToken(old), repository)).toMatchObject({ canChoose: false,
    message: links.find((link) => link.bookingId === old.bookingId)!.message });
  await expect(submitChoice(repository.customerToken(old), { action: "refund" }, repository)).rejects.toMatchObject({ status: 409 });
  expect(coverView(token, repository)).toMatchObject({ status: "withdrawn", canRespond: false });
  await expect(respondToCover(token, "accept", repository)).rejects.toMatchObject({ status: 409 });
  await expect(payCover(id, original.id, cover.sessionId, repository)).rejects.toMatchObject({ status: 409 });
  expect(ownerCovers(id, repository)).toHaveLength(1);
  expect(fetch).not.toHaveBeenCalled();
  closeRepository(); repository = getRepository();
  expect(activeConstraints(repository.requireWorkspace(id).state)).toEqual([]);
  expect(repository.getPlan(id, original.id)?.correctedBy).toBe(correction.id);
  await executePlan(id, correction.id, repository);
  expect(repository.listLedger(id)).toEqual(ledger);
});

it("rejects duplicate withdrawals, withdrawal of a correction and withdrawal of a proposed recovery", async () => {
  const { id, original, state } = await approved();
  const correction = await withdrawPlan(id, original.id, repository);
  expect((await post(id, original.id)).status).toBe(409);
  expect((await post(id, correction.id)).status).toBe(409);
  const proposed = repository.createPlan(id, replan(state, demoDisruption));
  expect((await post(id, proposed.id)).status).toBe(409);
  await executePlan(id, correction.id, repository);
  expect((await post(id, original.id)).status).toBe(409);
  expect((await post(id, correction.id)).status).toBe(409);
});

it("allows a fresh preview after discarding a correction", async () => {
  const { id, original } = await approved();
  const first = await withdrawPlan(id, original.id, repository);
  repository.discardPlan(id, first.id);
  expect((await withdrawPlan(id, original.id, repository)).status).toBe("proposed");
});

it("corrects a partially failed recovery without retrying its unsettled refund", async () => {
  const { id, original } = await approved(true);
  expect(original.status).toBe("partially_failed");
  const ledger = repository.listLedger(id);
  const pending = repository.requireWorkspace(id).state.bookings.filter((booking) => booking.status === "refund_pending");
  expect(pending).toHaveLength(1);
  const correction = await withdrawPlan(id, original.id, repository);
  expect(correction.bookingActions.some((action) => action.bookingId === pending[0].id)).toBe(false);
  const result = await executePlan(id, correction.id, repository);
  expect(result.results).toEqual([]);
  expect(repository.listLedger(id)).toEqual(ledger);
  expect(repository.requireWorkspace(id).state.bookings.find((booking) => booking.id === pending[0].id)?.status).toBe("refund_pending");
  expect(activeConstraints(repository.requireWorkspace(id).state)).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it("refuses cross-origin withdrawal without creating a proposal", async () => {
  const { id, original } = await approved();
  expect((await post(id, original.id, "https://other.example")).status).toBe(403);
  expect(repository.listPlans(id)).toHaveLength(1);
});

it("keeps a session changed after approval and explains why", async () => {
  const { id, original } = await approved();
  const state = repository.requireWorkspace(id).state;
  const change = original.sessionChanges.find((item) => item.after)!;
  const session = state.sessions.find((item) => item.id === change.sessionId)!;
  state.instructors.push({ ...state.instructors.find((item) => item.id === change.before.instructorId)!, id: "later-instructor" });
  session.instructorId = "later-instructor";
  repository.saveState(id, state);
  const correction = await withdrawPlan(id, original.id, repository);
  expect(correction.sessionChanges.some((item) => item.sessionId === session.id)).toBe(false);
  expect(correction.warnings.join(" ")).toContain("the class changed again after this recovery");
  expect(validate(state, correction).ok).toBe(true);
});

it("warns when the original room is now taken, without proposing a refund", async () => {
  const { id, original } = await approved();
  const state = repository.requireWorkspace(id).state;
  const change = original.sessionChanges.find((item) => item.remedy === "move_time")!;
  const session = state.sessions.find((item) => item.id === change.sessionId)!;
  state.instructors.push({ ...state.instructors.find((item) => item.id === change.before.instructorId)!, id: "different-instructor" });
  state.sessions.push({ ...session, ...change.before, id: "new-class", instructorId: "different-instructor" });
  repository.saveState(id, state);
  const correction = await withdrawPlan(id, original.id, repository);
  expect(correction.sessionChanges.some((item) => item.sessionId === session.id)).toBe(false);
  expect(correction.warnings.join(" ")).toContain("the original room is now taken");
  expect(correction.bookingActions.some((action) => action.action === "refund")).toBe(false);
  expect(validate(state, correction).ok).toBe(true);
});

it("leaves customer moves, credits and pending refunds untouched", async () => {
  const { id, original } = await approved();
  const state = repository.requireWorkspace(id).state;
  const active = state.bookings.filter((booking) => original.bookingActions.some((action) => action.bookingId === booking.id && action.action !== "refund"));
  active[0].sessionId = state.sessions.find((session) => !original.sessionChanges.some((change) => change.sessionId === session.id))!.id;
  active[1].status = "cancelled"; active[2].status = "refund_pending";
  const correction = planCorrection(state, original, new Date().toISOString());
  expect(correction.bookingActions.some((action) => active.slice(0, 3).some((booking) => action.bookingId === booking.id))).toBe(false);
  expect(correction.warnings.join(" ")).toContain("3 bookings with a refund pending, studio credit or another class stay unchanged");
});

it("preserves a customer's move into another recovery class", async () => {
  const { id, original } = await approved();
  const state = repository.requireWorkspace(id).state;
  const [first, second] = original.sessionChanges.filter((change) => change.after);
  const booking = state.bookings.find((item) => item.sessionId === first.sessionId && item.status !== "refunded")!;
  booking.sessionId = second.sessionId;
  const correction = planCorrection(state, original, new Date().toISOString());
  expect(correction.sessionChanges.some((change) => change.sessionId === second.sessionId)).toBe(false);
  expect(correction.bookingActions.some((action) => action.bookingId === booking.id)).toBe(false);
  expect(correction.warnings.join(" ")).toContain("a customer chose this class after the recovery");
});

it("keeps other active disruption constraints in force", async () => {
  const { id, original } = await approved();
  const state = repository.requireWorkspace(id).state;
  const extra = { kind: "closure" as const, from: "2030-01-01T00:00:00Z", to: "2030-01-02T00:00:00Z" };
  repository.saveState(id, { ...state, activeConstraints: [...activeConstraints(state), extra] } as typeof state);
  const correction = await withdrawPlan(id, original.id, repository);
  await executePlan(id, correction.id, repository);
  expect(activeConstraints(repository.requireWorkspace(id).state)).toEqual([extra]);
});

it("skips started classes and original times that have passed", async () => {
  const { id, original } = await approved();
  const state = repository.requireWorkspace(id).state;
  const now = new Date(Math.max(...original.sessionChanges.map((change) => Date.parse(change.before.end)))).toISOString();
  const correction = planCorrection(state, original, now);
  expect(correction.sessionChanges).toEqual([]);
  expect(correction.warnings.join(" ")).toContain("the class has already started");
  expect(correction.warnings.join(" ")).toContain("the original time has already passed");
});

it("leaves cancelled sessions out of the schedule", async () => {
  const { id, original } = await approved();
  const state = repository.requireWorkspace(id).state;
  const change = original.sessionChanges[0];
  state.sessions = state.sessions.filter((session) => session.id !== change.sessionId);
  const correction = planCorrection(state, { ...original, sessionChanges: [{ ...change, after: undefined, remedy: "cancel" }] }, new Date().toISOString());
  expect(correction.sessionChanges).toEqual([]);
  expect(correction.warnings.join(" ")).toContain("the cancelled class has left the schedule");
});

it("retains paid cover history and blocks new payout attempts", async () => {
  const { id, original } = await approved();
  const cover = ownerCovers(id, repository)[0], token = cover.path.slice(3);
  await respondToCover(token, "accept", repository);
  const link = repository.listCoverLinks(id)[0], now = new Date().toISOString();
  repository.saveCoverPayout({ workspaceId: id, planId: original.id, sessionId: cover.sessionId, instructorId: link.instructorId,
    amount: "35.00", attempt: 1, requestId: "settled-cover", status: "SUCCESS", itemId: "PAID-1", createdAt: now, updatedAt: now });
  const rows = repository.listCoverPayouts(id);
  const correction = await withdrawPlan(id, original.id, repository);
  await executePlan(id, correction.id, repository);
  expect(repository.listCoverPayouts(id)).toEqual(rows);
  expect(coverView(token, repository)).toMatchObject({ status: "withdrawn", canRespond: false, payout: { status: "SUCCESS", itemId: "PAID-1" } });
  await expect(payCover(id, original.id, cover.sessionId, repository)).rejects.toMatchObject({ status: 409 });
  expect(fetch).not.toHaveBeenCalled();
});

it("revalidates a stale preview before removing any constraint", async () => {
  const { id, original } = await approved();
  const correction = await withdrawPlan(id, original.id, repository);
  const state = repository.requireWorkspace(id).state;
  state.bookings.find((booking) => correction.bookingActions.some((action) => action.bookingId === booking.id))!.status = "cancelled";
  repository.saveState(id, state);
  await expect(executePlan(id, correction.id, repository)).rejects.toMatchObject({ status: 409 });
  expect(activeConstraints(repository.requireWorkspace(id).state)).toEqual([original.disruption]);
  expect(repository.getPlan(id, original.id)?.correctedBy).toBeUndefined();
});

it("adjusts and approves a hero correction without refunds, preserving stay and settled-payment warnings", async () => {
  const { id, original } = await approved();
  const state = repository.requireWorkspace(id).state;
  const blocked = original.sessionChanges.find((change) => change.remedy === "move_time")!;
  const session = state.sessions.find((item) => item.id === blocked.sessionId)!;
  state.instructors.push({ ...state.instructors[0], id: "new-instructor" });
  state.sessions.push({ ...session, ...blocked.before, id: "new-class", instructorId: "new-instructor" });
  repository.saveState(id, state);
  const correction = await withdrawPlan(id, original.id, repository);
  const input = { sessionId: "session-001", start: "2026-11-09T12:15:00Z" };
  expect(checkAdjustment(state, correction, input).valid).toBe(true);
  expect(checkAdjustment(state, correction, { sessionId: blocked.sessionId, start: blocked.before.start }).valid).toBe(false);
  const ledger = repository.listLedger(id);
  const response = await adjust(new Request("http://localhost/adjust", { method: "POST", body: JSON.stringify({ ...input, version: 1 }) }),
    { params: Promise.resolve({ id, planId: correction.id }) });
  expect(response.status).toBe(200);
  const adjusted = await response.json();
  expect(adjusted.sessionChanges.find((change: { sessionId: string }) => change.sessionId === input.sessionId)).toMatchObject({
    remedy: "move_time", ownerAdjusted: true, after: { start: "2026-11-09T12:15:00.000Z" },
    reason: "Owner adjusted the restored placement; customers were checked again.",
  });
  expect(validate(state, adjusted)).toEqual({ ok: true, errors: [] });
  expect(adjusted.totals).toMatchObject({ kept: 0, moved: correction.totals.moved + 9, refunded: 0, refundAmount: "0.00", revenueKept: correction.totals.revenueKept });
  expect(adjusted.warnings).toEqual(correction.warnings);
  expect(adjusted.warnings.join(" ")).toContain("the original room is now taken");
  expect(adjusted.warnings.join(" ")).toContain("6 refunds already issued stay refunded");
  expect(adjusted.bookingActions.every((action: { action: string }) => action.action !== "refund")).toBe(true);
  expect(await explainPlan(adjusted, state)).toMatchObject({ headline: "Your adjusted correction is ready" });
  expect(repository.requireWorkspace(id).state).toEqual(state);
  const result = await approve(new Request("http://localhost/approve", { method: "POST", body: JSON.stringify({ version: 2 }) }),
    { params: Promise.resolve({ id, planId: correction.id }) });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ plan: { status: "executed" }, results: [] });
  expect(repository.requireWorkspace(id).state.sessions.find((item) => item.id === input.sessionId)?.start).toBe("2026-11-09T12:15:00.000Z");
  expect(repository.listLedger(id)).toEqual(ledger);
  const updates = repository.listCustomerLinks(id).filter((link) => link.planId === correction.id && state.bookings.some((booking) => booking.id === link.bookingId && booking.sessionId === input.sessionId));
  expect(updates).toHaveLength(9);
  expect(updates.every((link) => link.message.body.includes("7:15 AM") && !link.message.body.includes("original time") && !link.message.body.includes("Reply for a refund"))).toBe(true);
  expect(activeConstraints(repository.requireWorkspace(id).state)).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it("undoes a correction adjustment and approves the restored previous placement", async () => {
  const { id, original } = await approved();
  const correction = await withdrawPlan(id, original.id, repository);
  const context = { params: Promise.resolve({ id, planId: correction.id }) };
  expect((await adjust(new Request("http://localhost/adjust", { method: "POST", body: JSON.stringify({ sessionId: "session-001", start: "2026-11-09T12:15:00Z", version: 1 }) }), context)).status).toBe(200);
  const response = await adjust(new Request("http://localhost/adjust", { method: "POST", body: JSON.stringify({ undo: true, version: 2 }) }), context);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ version: 3, sessionChanges: correction.sessionChanges, bookingActions: correction.bookingActions, totals: correction.totals, warnings: correction.warnings });
  expect(repository.getPlan(id, correction.id)?.lastAdjustment).toBeUndefined();
  await executePlan(id, correction.id, repository, 3);
  expect(samePlacement(repository.requireWorkspace(id).state.sessions.find((item) => item.id === "session-001")!, correction.sessionChanges[0].after!)).toBe(true);
});

it.each(["placement", "booking", "constraint"])("rejects an adjusted correction when its %s becomes stale", async (kind) => {
  const { id, original } = await approved();
  const correction = await withdrawPlan(id, original.id, repository);
  const state = repository.requireWorkspace(id).state;
  const adjusted = adjustPlan(state, correction, { sessionId: "session-001", start: "2026-11-09T12:15:00Z" });
  repository.savePlan({ ...correction, ...adjusted });
  if (kind === "placement") state.sessions.find((item) => item.id === "session-001")!.roomId = "room-02";
  else if (kind === "booking") state.bookings.find((booking) => adjusted.bookingActions.some((action) => action.bookingId === booking.id))!.status = "cancelled";
  else state.rooms.find((room) => room.id === "room-01")!.supports = [];
  repository.saveState(id, state);
  const ledger = repository.listLedger(id);
  await expect(executePlan(id, correction.id, repository)).rejects.toMatchObject({ status: 409 });
  expect(repository.listLedger(id)).toEqual(ledger);
  expect(activeConstraints(repository.requireWorkspace(id).state)).toEqual([original.disruption]);
  expect(repository.getPlan(id, original.id)?.correctedBy).toBeUndefined();
});
