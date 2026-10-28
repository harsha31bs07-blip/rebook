import type { State } from "../domain/types";
import { toCents } from "../domain/time";
import type { CustomerLink, LedgerEvent, StoredPlan } from "../store";

type RecoveryPlan = Pick<StoredPlan, "id" | "workspaceId" | "status" | "createdAt" | "bookingActions" | "results">;

/** One current recovery record per booking. Reply tracking is separate from applied booking status. */
export function recoveryOutcomes(state: State, plans: RecoveryPlan[], ledger: LedgerEvent[], links: CustomerLink[] = []) {
  const latest = new Map<string, { plan: RecoveryPlan; action: RecoveryPlan["bookingActions"][number]; originalAmount: number }>();
  const appliedAt = (plan: RecoveryPlan) => links.find((link) => link.workspaceId === plan.workspaceId && link.planId === plan.id)?.createdAt ?? plan.createdAt;
  for (const plan of [...plans].sort((a, b) => appliedAt(a).localeCompare(appliedAt(b)))) {
    if (plan.status === "proposed") continue;
    for (const action of plan.bookingActions) latest.set(action.bookingId, {
      plan, action, originalAmount: latest.get(action.bookingId)?.originalAmount ?? toCents(action.amount),
    });
  }
  const events = new Map<string, LedgerEvent>();
  for (const event of ledger) events.set(`${event.workspaceId}:${event.kind}:${event.requestId}`, event);
  return [...latest.values()].map(({ plan, action, originalAmount: plannedAmount }) => {
    const booking = state.bookings.find((item) => item.id === action.bookingId);
    const capture = [...events.values()].find((event) => event.workspaceId === plan.workspaceId && event.bookingId === action.bookingId && event.kind === "capture" &&
      event.captureId === booking?.payment?.captureId && ["COMPLETED", "SIMULATED"].includes(event.status));
    const originalAmount = capture ? toCents(capture.amount) : plannedAmount;
    const link = links.filter((item) => item.workspaceId === plan.workspaceId && item.planId === plan.id && item.bookingId === action.bookingId).at(-1);
    const refunds = [...events.values()].filter((event) => event.workspaceId === plan.workspaceId && event.bookingId === action.bookingId && event.kind === "refund" && event.status !== "MERGED");
    const settled = refunds.filter((event) => ["COMPLETED", "SIMULATED"].includes(event.status));
    const amount = (items: LedgerEvent[]) => items.reduce((sum, event) => sum + toCents(event.amount), 0);
    const result = plan.results.find((item) => item.bookingId === action.bookingId);
    // The ledger wins; results support an approval response before the workspace refresh arrives.
    const fallbackStatus = refunds.length ? undefined : result?.status;
    const completedAmount = amount(settled.filter((event) => event.status === "COMPLETED")) || (fallbackStatus === "COMPLETED" ? toCents(action.amount) : 0);
    const simulatedAmount = amount(settled.filter((event) => event.status === "SIMULATED")) || (fallbackStatus === "SIMULATED" ? toCents(action.amount) : 0);
    const refundedAmount = completedAmount + simulatedAmount;
    const refundIntent = action.action === "refund" || link?.reply?.action === "refund" || ["refund_pending", "refunded"].includes(booking?.status ?? "") || refundedAmount >= originalAmount;
    const fullySettled = refundIntent && refundedAmount >= originalAmount;
    const pending = refunds.some((event) => ["REQUESTED", "PENDING", "UNKNOWN", "NEEDS_REVIEW"].includes(event.status)) ||
      (refundIntent && !fullySettled);
    const saved = !refundIntent && refundedAmount < originalAmount;
    const moved = saved && (link?.reply?.action === "move" || action.action === "move");
    const noReply = !refundIntent && !link?.reply;
    const failed = refunds.some((event) => ["FAILED", "CANCELLED", "NEEDS_REVIEW"].includes(event.status));
    return {
      booking_id: action.bookingId, customer_id: action.customerId, plan_id: plan.id, planned_remedy: action.action,
      customer_reply: link?.reply?.action ?? "none", outcome: fullySettled ? simulatedAmount ? "simulated_refund" : "refunded" : refundIntent ? "pending" : moved ? "moved" : "kept",
      kept: saved && !moved ? 1 : 0, moved: moved ? 1 : 0, saved: saved ? 1 : 0,
      refunded: fullySettled && !simulatedAmount ? 1 : 0, simulated_refunded: fullySettled && simulatedAmount > 0 ? 1 : 0,
      pending: pending ? 1 : 0, no_reply: noReply ? 1 : 0,
      revenue_kept: saved ? Math.max(0, originalAmount - refundedAmount) / 100 : 0,
      completed_refund_amount: completedAmount / 100, simulated_refund_amount: simulatedAmount / 100,
      payment_state: pending ? failed ? "needs_attention" : "pending" : simulatedAmount ? "simulated_refund" : completedAmount ? "completed_refund" : "captured",
      final: !noReply && !pending && !failed,
    };
  });
}

export type RecoveryOutcome = ReturnType<typeof recoveryOutcomes>[number];

export function summarizeRecovery(outcomes: RecoveryOutcome[]) {
  const sum = (field: "kept" | "moved" | "saved" | "refunded" | "simulated_refunded" | "pending" | "no_reply" | "revenue_kept" | "completed_refund_amount" | "simulated_refund_amount") =>
    outcomes.reduce((total, item) => total + Math.round(item[field] * 100), 0) / 100;
  return { affected: outcomes.length, kept: sum("kept"), moved: sum("moved"), saved: sum("saved"), refunded: sum("refunded"),
    simulatedRefunded: sum("simulated_refunded"), pending: sum("pending"), noReply: sum("no_reply"), revenueKept: sum("revenue_kept"),
    completedRefundAmount: sum("completed_refund_amount"), simulatedRefundAmount: sum("simulated_refund_amount"),
    noReplyCustomers: new Set(outcomes.filter((item) => item.no_reply).map((item) => item.customer_id)).size,
    complete: outcomes.length > 0 && outcomes.every((item) => item.final) };
}
