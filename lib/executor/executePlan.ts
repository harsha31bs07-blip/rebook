import { randomUUID } from "node:crypto";
import { toCents } from "../domain/time";
import { applyPlan, validate } from "../solver/validate";
import { PayPalError, refundCapture } from "../paypal/client";
import { getRepository, StoreError, withWorkspaceLock, type ExecutionResult, type LedgerEvent, type Repository, type StoredPlan } from "../store";

const reserved = (event: LedgerEvent) => ["REQUESTED", "PENDING", "COMPLETED", "SIMULATED"].includes(event.status);

/** A durable REQUESTED event precedes every refund. Crash recovery uses the same PayPal request ID. */
export async function executePlan(workspaceId: string, planId: string, repository: Repository = getRepository()): Promise<{ plan: StoredPlan; results: ExecutionResult[] }> {
  return withWorkspaceLock(repository, workspaceId, async (owner) => {
    let plan = repository.getPlan(workspaceId, planId);
    if (!plan) throw new StoreError(404, "Plan not found");
    if (plan.status === "executed" || plan.status === "partially_failed") return { plan, results: plan.results };
    const workspace = repository.requireWorkspace(workspaceId);
    if (plan.status !== "proposed" && (plan.status !== "executing" || !plan.basis)) throw new StoreError(409, "Plan cannot be executed");
    const basis = plan.status === "proposed" ? workspace.state : plan.basis!;
    const validation = validate(basis, plan);
    if (!validation.ok) throw new StoreError(409, `Plan is no longer valid: ${validation.errors.join("; ")}`);
    if (plan.status === "proposed") {
      // Preserve existing terminal money states when applying the pure scheduling transformation.
      const next = applyPlan(workspace.state, plan);
      for (const booking of next.bookings) {
        const previous = workspace.state.bookings.find((item) => item.id === booking.id)!;
        if (["refunded", "refund_pending", "cancelled"].includes(previous.status)) booking.status = previous.status;
      }
      plan = { ...plan, status: "executing", basis };
      repository.transaction(() => { repository.saveState(workspaceId, next); repository.savePlan(plan!); });
    }
    const results: ExecutionResult[] = [];
    for (const action of plan.bookingActions.filter((item) => item.action === "refund")) {
      repository.renewLock(workspaceId, owner);
      const requestId = `${planId}:${action.bookingId}`;
      const state = repository.requireWorkspace(workspaceId).state;
      const booking = state.bookings.find((item) => item.id === action.bookingId);
      const latest = repository.latestMoneyEvents(workspaceId);
      const previous = latest.find((event) => event.kind === "refund" && event.requestId === requestId);
      let result: ExecutionResult;
      if (previous && previous.status !== "REQUESTED") {
        result = { bookingId: action.bookingId, status: previous.status, paypalId: previous.paypalId, debugId: previous.debugId };
        if (booking && ["COMPLETED", "SIMULATED"].includes(previous.status)) {
          booking.status = "refunded";
          repository.saveState(workspaceId, state);
        }
      } else {
        let attempted = false;
        try {
          if (!booking?.payment) throw new Error("Booking has no captured payment");
          const captureId = booking.payment.captureId;
          const capture = latest.find((event) => event.kind === "capture" && event.paypalId === captureId);
          const otherRefunds = latest.filter((event) => event.kind === "refund" && event.captureId === captureId && event.requestId !== requestId && reserved(event));
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
            repository.appendLedger({ ...input, paypalId: delivered?.paypalId ?? refund.id, status, debugId: refund.debugId });
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
            const uncertain = !(error instanceof PayPalError) || error.status >= 500;
            const status = attempted && uncertain ? "REQUESTED" : "FAILED";
            result = { bookingId: action.bookingId, status, error: error instanceof PayPalError ? "PayPal refund failed" : error instanceof Error ? error.message : "Refund failed", debugId };
            repository.appendLedger({ workspaceId, bookingId: action.bookingId, kind: "refund", amount: action.amount,
              captureId: booking?.payment?.captureId ?? "", requestId, paypalId: "", status, debugId });
          }
        }
      }
      results.push(result);
      plan = { ...plan, results: [...results] };
      repository.savePlan(plan);
    }
    plan = { ...plan, results, status: results.some((result) => !["COMPLETED", "PENDING", "SIMULATED"].includes(result.status)) ? "partially_failed" : "executed" };
    repository.savePlan(plan);
    return { plan, results };
  });
}
