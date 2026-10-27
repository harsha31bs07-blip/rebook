import { describe, expect, it } from "vitest";
import { recoveryOutcomes, summarizeRecovery } from "../lib/recovery/outcomes";
import { buildInsights } from "../lib/insights/data";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import type { CustomerLink, LedgerEvent, StoredPlan } from "../lib/store";

const state = seedStudio();
const proposal = replan(state, demoDisruption);
const plan: StoredPlan = { ...proposal, id: "first", workspaceId: "workspace", createdAt: "2026-11-01T12:00:00Z", status: "executed", results: [] };
const action = plan.bookingActions.find((item) => item.action === "keep")!;
function event(requestId: string, amount: string, status: string, bookingId = action.bookingId, partial = false): LedgerEvent {
  return { id: requestId + status, workspaceId: plan.workspaceId, bookingId, kind: "refund", amount, paypalId: "refund", captureId: "capture", requestId, status, createdAt: "2026-11-02T12:00:00Z", partial };
}
function link(reply?: CustomerLink["reply"], planId = plan.id): CustomerLink {
  return { id: "private", tokenHash: "private", workspaceId: plan.workspaceId, planId, bookingId: action.bookingId, kind: "choice", createdAt: plan.createdAt, expiresAt: Date.parse("2026-11-09T00:00:00Z"), before: state.sessions[0], message: { subject: "Class changed", body: "Choose" }, reply };
}

describe("current booking recovery outcomes", () => {
  it("counts a booking once under the latest applied plan and ignores a newer proposal", () => {
    const second = { ...plan, id: "second", createdAt: "2026-11-02T12:00:00Z", bookingActions: [{ ...action, action: "move" as const }] };
    const proposed = { ...second, id: "third", status: "proposed" as const, createdAt: "2026-11-03T12:00:00Z" };
    const data = buildInsights(state, [proposed, second, plan], []);
    expect(data.disruptions.reduce((sum, row) => sum + row.applied_affected, 0)).toBe(31);
    expect(data.disruptions.reduce((sum, row) => sum + row.applied_saved, 0)).toBe(25);
    expect(data.disruptions.reduce((sum, row) => sum + row.applied_revenue_kept, 0)).toBe(577);
    const outcomes = recoveryOutcomes(state, [plan, second, proposed], [], [link({ action: "keep", at: plan.createdAt, amount: "0.00" })]);
    expect(outcomes.find((item) => item.booking_id === action.bookingId)).toMatchObject({ plan_id: "second", planned_remedy: "move", moved: 1, no_reply: 1 });
  });

  it("subtracts earlier settled price differences after a repeat disruption and keeps pending separate", () => {
    const second = { ...plan, id: "second", createdAt: "2026-11-02T12:00:00Z", bookingActions: [{ ...action, action: "move" as const, amount: "18.00" }] };
    const choice = link({ action: "move", sessionId: "alternative", at: second.createdAt, requestId: "choice:private", amount: "4.00" }, second.id);
    const pending = recoveryOutcomes(state, [plan, second], [event("choice:private", "4.00", "PENDING", action.bookingId, true)], [choice]).find((item) => item.booking_id === action.bookingId)!;
    expect(pending).toMatchObject({ saved: 1, moved: 1, pending: 1, no_reply: 0, revenue_kept: 22, final: false });
    const completed = recoveryOutcomes(state, [plan, second], [event("choice:private", "4.00", "PENDING", action.bookingId, true), event("choice:private", "4.00", "COMPLETED", action.bookingId, true)], [choice]).find((item) => item.booking_id === action.bookingId)!;
    expect(completed).toMatchObject({ saved: 1, moved: 1, refunded: 0, pending: 0, revenue_kept: 18, completed_refund_amount: 4, final: true });
    const third = { ...second, id: "third", createdAt: "2026-11-03T12:00:00Z" };
    expect(recoveryOutcomes(state, [plan, second, third], [event("choice:private", "4.00", "COMPLETED", action.bookingId, true)]).find((item) => item.booking_id === action.bookingId)?.revenue_kept).toBe(18);
  });

  it("uses the original capture when a price-difference refund predates the first recovery", () => {
    const reduced = { ...plan, bookingActions: [{ ...action, amount: "18.00" }] };
    const capture = { ...event("capture", "22.00", "COMPLETED"), kind: "capture" as const, captureId: state.bookings.find((item) => item.id === action.bookingId)!.payment!.captureId };
    const outcomes = recoveryOutcomes(state, [reduced], [capture, event("earlier-choice", "4.00", "COMPLETED", action.bookingId, true)]);
    expect(outcomes[0]).toMatchObject({ revenue_kept: 18, completed_refund_amount: 4, saved: 1 });
  });

  it("uses the application time rather than proposal time for repeated disruptions", () => {
    const laterApproval = { ...plan, id: "later-approval", createdAt: "2026-10-31T12:00:00Z", bookingActions: [{ ...action, action: "move" as const }] };
    const approvedLink = { ...link(undefined, laterApproval.id), createdAt: "2026-11-03T12:00:00Z" };
    const outcomes = recoveryOutcomes(state, [laterApproval, plan], [], [approvedLink]);
    expect(outcomes.find((item) => item.booking_id === action.bookingId)).toMatchObject({ plan_id: laterApproval.id, moved: 1 });
  });

  it("never calls simulated or failed refunds completed", () => {
    const refundAction = plan.bookingActions.find((item) => item.action === "refund")!;
    const one = { ...plan, bookingActions: [refundAction] };
    for (const status of ["REQUESTED", "PENDING", "FAILED", "CANCELLED", "UNKNOWN"]) {
      const summary = summarizeRecovery(recoveryOutcomes(state, [one], [event(`${one.id}:${refundAction.bookingId}`, refundAction.amount, status, refundAction.bookingId)]));
      expect(summary).toMatchObject({ refunded: 0, pending: 1, revenueKept: 0, complete: false });
    }
    expect(summarizeRecovery(recoveryOutcomes(state, [one], [event(`${one.id}:${refundAction.bookingId}`, refundAction.amount, "SIMULATED", refundAction.bookingId)]))).toMatchObject({ refunded: 0, simulatedRefunded: 1, pending: 0, completedRefundAmount: 0 });
  });
});
