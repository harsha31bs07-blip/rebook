import { randomUUID } from "node:crypto";
import { toCents } from "../domain/time";
import { reconcileRefund } from "./reconcileRefund";
import { PayPalError, refundCapture } from "../paypal/client";
import type { ExecutionResult, LedgerEvent, Repository } from "../store";

const reserved = (event: LedgerEvent) => ["REQUESTED", "PENDING", "COMPLETED", "SIMULATED"].includes(event.status);

/** Shared durable refund writer. Caller must hold the workspace execution lease. */
export async function executeRefund(workspaceId: string, input: { bookingId: string; amount: string; reason: string; partial?: boolean },
  requestId: string, repository: Repository, renew: () => void): Promise<ExecutionResult> {
  const state = repository.requireWorkspace(workspaceId).state;
  const booking = state.bookings.find((item) => item.id === input.bookingId);
  const latest = repository.latestMoneyEvents(workspaceId);
  let previous = latest.find((event) => event.kind === "refund" && event.requestId === requestId);
  let retryAllowed = !previous;
  if (previous && ["REQUESTED", "FAILED", "PENDING"].includes(previous.status)) {
    const outcome = await reconcileRefund(previous, repository);
    retryAllowed = outcome.kind !== "found" && (previous.status === "REQUESTED" || outcome.kind === "absent");
    previous = repository.latestMoneyEvents(workspaceId).find((event) => event.kind === "refund" && event.requestId === requestId);
    if (previous && ["COMPLETED", "PENDING", "SIMULATED"].includes(previous.status)) retryAllowed = false;
  }
  renew();
  let result: ExecutionResult;
  if (previous && !retryAllowed) {
    result = { bookingId: input.bookingId, status: previous.status, paypalId: previous.paypalId || undefined, debugId: previous.debugId, error: previous.error };
    if (["COMPLETED", "SIMULATED"].includes(previous.status)) {
      const current = repository.requireWorkspace(workspaceId).state;
      const updated = current.bookings.find((item) => item.id === input.bookingId && item.payment?.captureId === previous?.captureId);
      if (!input.partial && updated && updated.status !== "refunded") { updated.status = "refunded"; repository.saveState(workspaceId, current); }
    }
  } else {
    let attempted = false;
    try {
      const booking = repository.requireWorkspace(workspaceId).state.bookings.find((item) => item.id === input.bookingId);
      if (!booking?.payment) throw new Error("Booking has no captured payment");
      const captureId = booking.payment.captureId;
      if (previous && captureId !== previous.captureId) throw new Error("Booking capture changed since the original refund request");
      const money = repository.latestMoneyEvents(workspaceId);
      const capture = money.find((event) => event.kind === "capture" && event.paypalId === captureId);
      const otherRefunds = money.filter((event) => event.kind === "refund" && event.captureId === captureId && event.requestId !== requestId && reserved(event));
      if (booking.status === "refunded" || otherRefunds.some((event) => ["REQUESTED", "PENDING"].includes(event.status))) throw new Error("Payment already refunded or reserved by another refund");
      if (!capture || !["COMPLETED", "SIMULATED"].includes(capture.status)) throw new Error("Payment capture is not completed");
      if (toCents(input.amount) <= 0 || toCents(input.amount) > toCents(capture.amount) - otherRefunds.reduce((sum, event) => sum + toCents(event.amount), 0)) throw new Error("Refund exceeds captured amount");
      const ledgerInput = { workspaceId, bookingId: booking.id, kind: "refund" as const, amount: input.amount, captureId, requestId, ...(input.partial ? { partial: true } : {}) };
      repository.appendLedger({ ...ledgerInput, paypalId: "", status: "REQUESTED" });
      attempted = true;
      const refund = booking.payment.simulated
        ? { id: `SIM-REFUND-${randomUUID()}`, status: "SIMULATED", debugId: undefined }
        : await refundCapture(captureId, input.amount, input.reason, requestId);
      if (!refund.id || !refund.status) throw new Error("Invalid PayPal refund response");
      // A webhook may have completed the refund while the HTTP request was in flight.
      const delivered = repository.latestMoneyEvents(workspaceId).find((event) => event.kind === "refund" && event.requestId === requestId && event.status === "COMPLETED");
      const status = delivered?.status ?? refund.status;
      repository.transaction(() => {
        repository.appendLedger({ ...ledgerInput, paypalId: delivered?.paypalId ?? refund.id, status, debugId: refund.debugId,
          error: status === "FAILED" ? "PayPal reports that this refund failed" : undefined });
        const current = repository.requireWorkspace(workspaceId).state;
        const updated = current.bookings.find((item) => item.id === booking.id)!;
        if (!input.partial) updated.status = ["COMPLETED", "SIMULATED"].includes(status) ? "refunded" : "refund_pending";
        repository.saveState(workspaceId, current);
      });
      result = { bookingId: booking.id, status, paypalId: refund.id, debugId: refund.debugId };
    } catch (error) {
      const debugId = error instanceof PayPalError ? error.debugId : undefined;
      const delivered = repository.latestMoneyEvents(workspaceId).find((event) => event.kind === "refund" && event.requestId === requestId && event.status === "COMPLETED");
      if (delivered) {
        result = { bookingId: input.bookingId, status: delivered.status, paypalId: delivered.paypalId, debugId: delivered.debugId };
      } else {
        // Transport and server errors have unknown outcomes; retain their reservation.
        const uncertain = !(error instanceof PayPalError) || error.status >= 500 || [408, 429].includes(error.status);
        const status = (attempted && uncertain) || (!attempted && previous?.status === "REQUESTED") ? "REQUESTED" : "FAILED";
        result = { bookingId: input.bookingId, status, error: error instanceof PayPalError ? `${error.name}: ${error.message}` : error instanceof Error ? error.message : "Refund failed", debugId };
        repository.appendLedger({ workspaceId, bookingId: input.bookingId, kind: "refund", amount: input.amount,
          captureId: booking?.payment?.captureId ?? "", requestId, ...(input.partial ? { partial: true } : {}), paypalId: previous?.paypalId ?? "", status, debugId, error: result.error });
      }
    }
  }
  return result;
}
