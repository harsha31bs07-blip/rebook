import { randomUUID } from "node:crypto";
import { toCents } from "../domain/time";
import { applyPlan, validate } from "../solver/validate";
import { activateConstraint } from "../solver/constraints";
import { reconcileRefund } from "./reconcileRefund";
import { PayPalError, refundCapture } from "../paypal/client";
import { getRepository, StoreError, withWorkspaceLock, type ExecutionResult, type LedgerEvent, type Repository, type StoredPlan } from "../store";

const reserved = (event: LedgerEvent) => ["REQUESTED", "PENDING", "COMPLETED", "SIMULATED"].includes(event.status);

/** A durable REQUESTED event precedes every refund. Crash recovery uses the same PayPal request ID. */
export async function executePlan(workspaceId: string, planId: string, repository: Repository = getRepository()): Promise<{ plan: StoredPlan; results: ExecutionResult[] }> {
  repository.requireReadyWorkspace(workspaceId);
  return withWorkspaceLock(repository, workspaceId, async (owner) => {
    let plan = repository.getPlan(workspaceId, planId);
    if (!plan) throw new StoreError(404, "Plan not found");
    if (plan.status === "executed") return { plan, results: plan.results };
    const workspace = repository.requireReadyWorkspace(workspaceId);
    if (plan.status !== "proposed" && (!["executing", "partially_failed"].includes(plan.status) || !plan.basis)) throw new StoreError(409, "Plan cannot be executed");
    const basis = plan.status === "proposed" ? workspace.state : plan.basis!;
    const validation = validate(basis, plan);
    if (!validation.ok) throw new StoreError(409, `Plan is no longer valid: ${validation.errors.join("; ")}`);
    if (plan.status === "proposed") {
      // Preserve existing terminal money states when applying the pure scheduling transformation.
      const next = activateConstraint(applyPlan(workspace.state, plan), plan.disruption);
      for (const booking of next.bookings) {
        const previous = workspace.state.bookings.find((item) => item.id === booking.id)!;
        if (["refunded", "refund_pending", "cancelled"].includes(previous.status)) booking.status = previous.status;
      }
      plan = { ...plan, status: "executing", basis };
      repository.transaction(() => { repository.saveState(workspaceId, next); repository.savePlan(plan!); });
    } else {
      plan = { ...plan, status: "executing" };
      repository.savePlan(plan);
    }
    const results: ExecutionResult[] = [];
    for (const action of plan.bookingActions.filter((item) => item.action === "refund")) {
      repository.renewLock(workspaceId, owner);
      const requestId = `${planId}:${action.bookingId}`;
      const state = repository.requireWorkspace(workspaceId).state;
      const booking = state.bookings.find((item) => item.id === action.bookingId);
      const latest = repository.latestMoneyEvents(workspaceId);
      let previous = latest.find((event) => event.kind === "refund" && event.requestId === requestId);
      let retryAllowed = !previous;
      if (previous && ["REQUESTED", "FAILED"].includes(previous.status)) {
        const outcome = await reconcileRefund(previous, repository);
        retryAllowed = outcome.kind !== "found" && (previous.status === "REQUESTED" || outcome.kind === "absent");
        previous = repository.latestMoneyEvents(workspaceId).find((event) => event.kind === "refund" && event.requestId === requestId);
        if (previous && ["COMPLETED", "PENDING", "SIMULATED"].includes(previous.status)) retryAllowed = false;
      }
      repository.renewLock(workspaceId, owner);
      let result: ExecutionResult;
      if (previous && !retryAllowed) {
        result = { bookingId: action.bookingId, status: previous.status, paypalId: previous.paypalId || undefined, debugId: previous.debugId, error: previous.error };
        if (["COMPLETED", "SIMULATED"].includes(previous.status)) {
          const current = repository.requireWorkspace(workspaceId).state;
          const updated = current.bookings.find((item) => item.id === action.bookingId && item.payment?.captureId === previous?.captureId);
          if (updated && updated.status !== "refunded") { updated.status = "refunded"; repository.saveState(workspaceId, current); }
        }
      } else {
        let attempted = false;
        try {
          const booking = repository.requireWorkspace(workspaceId).state.bookings.find((item) => item.id === action.bookingId);
          if (!booking?.payment) throw new Error("Booking has no captured payment");
          const captureId = booking.payment.captureId;
          if (previous && captureId !== previous.captureId) throw new Error("Booking capture changed since the original refund request");
          const money = repository.latestMoneyEvents(workspaceId);
          const capture = money.find((event) => event.kind === "capture" && event.paypalId === captureId);
          const otherRefunds = money.filter((event) => event.kind === "refund" && event.captureId === captureId && event.requestId !== requestId && reserved(event));
          if (booking.status === "refunded" || otherRefunds.length) throw new Error("Payment already refunded or reserved by another refund");
          if (!capture || !["COMPLETED", "SIMULATED"].includes(capture.status)) throw new Error("Payment capture is not completed");
          if (toCents(action.amount) <= 0 || toCents(action.amount) > toCents(capture.amount)) throw new Error("Refund exceeds captured amount");
          const input = { workspaceId, bookingId: booking.id, kind: "refund" as const, amount: action.amount, captureId, requestId };
          repository.appendLedger({ ...input, paypalId: "", status: "REQUESTED" });
          attempted = true;
          const refund = booking.payment.simulated
            ? { id: `SIM-REFUND-${randomUUID()}`, status: "SIMULATED", debugId: undefined }
            : await refundCapture(captureId, action.amount, action.reason, requestId);
          if (!refund.id || !refund.status) throw new Error("Invalid PayPal refund response");
          // A webhook may have completed the refund while the HTTP request was in flight.
          const delivered = repository.latestMoneyEvents(workspaceId).find((event) => event.kind === "refund" && event.requestId === requestId && event.status === "COMPLETED");
          const status = delivered?.status ?? refund.status;
          repository.transaction(() => {
            repository.appendLedger({ ...input, paypalId: delivered?.paypalId ?? refund.id, status, debugId: refund.debugId,
              error: status === "FAILED" ? "PayPal reports that this refund failed" : undefined });
            const current = repository.requireWorkspace(workspaceId).state;
            const updated = current.bookings.find((item) => item.id === booking.id)!;
            updated.status = ["COMPLETED", "SIMULATED"].includes(status) ? "refunded" : "refund_pending";
            repository.saveState(workspaceId, current);
          });
          result = { bookingId: booking.id, status, paypalId: refund.id, debugId: refund.debugId };
        } catch (error) {
          const debugId = error instanceof PayPalError ? error.debugId : undefined;
          const delivered = repository.latestMoneyEvents(workspaceId).find((event) => event.kind === "refund" && event.requestId === requestId && event.status === "COMPLETED");
          if (delivered) {
            result = { bookingId: action.bookingId, status: delivered.status, paypalId: delivered.paypalId, debugId: delivered.debugId };
          } else {
            // Transport and server errors have unknown outcomes; retain their reservation.
            const uncertain = !(error instanceof PayPalError) || error.status >= 500 || [408, 429].includes(error.status);
            const status = (attempted && uncertain) || (!attempted && previous?.status === "REQUESTED") ? "REQUESTED" : "FAILED";
            result = { bookingId: action.bookingId, status, error: error instanceof PayPalError ? `${error.name}: ${error.message}` : error instanceof Error ? error.message : "Refund failed", debugId };
            repository.appendLedger({ workspaceId, bookingId: action.bookingId, kind: "refund", amount: action.amount,
              captureId: booking?.payment?.captureId ?? "", requestId, paypalId: previous?.paypalId ?? "", status, debugId, error: result.error });
          }
        }
      }
      results.push(result);
      plan = { ...plan, results: [...results] };
      repository.savePlan(plan);
    }
    plan = { ...plan, results, status: results.some((result) => !["COMPLETED", "PENDING", "SIMULATED"].includes(result.status)) ? "partially_failed" : "executed" };
    repository.savePlan(plan);
    const view = repository.getPlan(workspaceId, planId)!;
    return { plan: view, results: view.results };
  });
}
