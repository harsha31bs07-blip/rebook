import { setSdkTransport } from "./paypalTransport";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Repository } from "../lib/store";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { executePlan } from "../lib/executor/executePlan";
import { ownerCustomerChoices } from "../lib/choices/service";
import { pausedSessionIds } from "../lib/checkout/service";
import { recoveryOutcomes } from "../lib/recovery/outcomes";

let repository: Repository, directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rebook-recovery-review-"));
  vi.stubEnv("DATA_DIR", directory);
  repository = new Repository(directory);
  setSdkTransport(async () => { throw new Error("Unexpected transport call"); });
});
afterEach(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function simulatedWorkspace() {
  const state = seedStudio();
  for (const booking of state.bookings) booking.payment!.simulated = true;
  const workspace = repository.createWorkspace(state);
  for (const booking of state.bookings) repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "capture", amount: booking.amount,
    paypalId: booking.payment!.captureId, captureId: booking.payment!.captureId, requestId: `capture:${booking.id}`, status: "SIMULATED" });
  return workspace;
}

it("approving one preview discards superseded previews so their classes do not stay paused", async () => {
  const workspace = simulatedWorkspace();
  const first = repository.createPlan(workspace.id, replan(workspace.state, demoDisruption));
  repository.createPlan(workspace.id, replan(workspace.state, demoDisruption));
  expect(pausedSessionIds(workspace.id, repository).size).toBeGreaterThan(0);
  await executePlan(workspace.id, first.id, repository);
  expect(repository.listPlans(workspace.id).map((plan) => plan.status)).not.toContain("proposed");
  expect(pausedSessionIds(workspace.id, repository).size).toBe(0);
});

it("labels a customer's refund as requested until the booking is actually refunded", async () => {
  const workspace = simulatedWorkspace();
  const plan = repository.createPlan(workspace.id, replan(workspace.state, demoDisruption));
  await executePlan(workspace.id, plan.id, repository);
  const link = repository.listCustomerLinks(workspace.id).find((item) => item.kind === "choice")!;
  repository.saveCustomerLink({ ...link, reply: { action: "refund", at: new Date().toISOString(), amount: "22.00" } });
  const status = () => ownerCustomerChoices(workspace.id, repository).outbox.flatMap((row) => row.changes).find((change) => change.bookingId === link.bookingId)?.reply?.status;
  expect(status()).toBe("refund requested");
  const state = repository.requireWorkspace(workspace.id).state;
  state.bookings.find((booking) => booking.id === link.bookingId)!.status = "refunded";
  repository.saveState(workspace.id, state);
  expect(status()).toBe("refunded");
});

it("a reversed capture is not counted as kept revenue", async () => {
  const workspace = simulatedWorkspace();
  const plan = repository.createPlan(workspace.id, replan(workspace.state, demoDisruption));
  await executePlan(workspace.id, plan.id, repository);
  const kept = plan.bookingActions.find((action) => action.action !== "refund")!;
  const before = recoveryOutcomes(repository.requireWorkspace(workspace.id).state, repository.listPlans(workspace.id), repository.listLedger(workspace.id))
    .find((item) => item.booking_id === kept.bookingId)!;
  expect(before.saved).toBe(1);
  const state = repository.requireWorkspace(workspace.id).state;
  const booking = state.bookings.find((item) => item.id === kept.bookingId)!;
  booking.status = "cancelled";
  repository.saveState(workspace.id, state);
  repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "capture", amount: booking.amount, paypalId: booking.payment!.captureId,
    captureId: booking.payment!.captureId, requestId: `capture:${booking.id}`, status: "REVERSED" });
  const after = recoveryOutcomes(repository.requireWorkspace(workspace.id).state, repository.listPlans(workspace.id), repository.listLedger(workspace.id))
    .find((item) => item.booking_id === kept.bookingId)!;
  expect(after).toMatchObject({ saved: 0, kept: 0, moved: 0, revenue_kept: 0, outcome: "reversed", payment_state: "reversed" });
});
