import { randomUUID } from "node:crypto";
import { fromCents, toCents } from "../domain/time";
import { unreturnedRedemption } from "../credits/balance";
import { reconcileRefund } from "./reconcileRefund";
import { canReplayRefund, reviewUncertainRefund } from "./refund-policy";
import { PayPalError, refundCapture } from "../paypal/client";
import { StoreError, type ExecutionResult, type LedgerEvent, type Repository } from "../store";

const reserved = (event: LedgerEvent) => ["REQUESTED", "PENDING", "NEEDS_REVIEW", "COMPLETED", "SIMULATED"].includes(event.status);

/** Shared durable refund writer. Caller must hold the workspace execution lease. */
export async function executeRefund(workspaceId: string, input: { bookingId: string; amount: string; reason: string; partial?: boolean },
  requestId: string, repository: Repository, renew: () => void): Promise<ExecutionResult> {
  const state = repository.requireWorkspace(workspaceId).state;
  const latest = repository.latestMoneyEvents(workspaceId);
  let previous = latest.find((event) => event.kind === "refund" && event.requestId === requestId);
  if (previous && (previous.bookingId !== input.bookingId || previous.amount !== input.amount || !!previous.partial !== !!input.partial)) {
    throw new StoreError(409, "Refund identity, amount or type changed since the original request");
  }
  if (state.bookings.find((booking) => booking.id === input.bookingId)?.entitlement) return repository.transaction(() => {
    renew();
    const current = repository.requireWorkspace(workspaceId).state;
    const booking = current.bookings.find((item) => item.id === input.bookingId)!;
    if (input.amount !== "0.00" || input.partial || booking.payment) throw new StoreError(409, "A visit return must have zero amount and no payment");
    const recorded = repository.latestMoneyEvents(workspaceId).find((event) => event.kind === "refund" && event.requestId === requestId);
    if (recorded?.status !== "VISIT_RETURNED") {
      if (repository.latestMoneyEvents(workspaceId).some((event) => event.kind === "refund" && event.bookingId === booking.id && event.status === "VISIT_RETURNED")) {
        throw new StoreError(409, "This visit has already been returned");
      }
      repository.appendLedger({ workspaceId, bookingId: booking.id, kind: "refund", amount: "0.00", captureId: "", requestId,
        paypalId: "", status: "VISIT_RETURNED" });
    }
    booking.status = "refunded";
    repository.saveState(workspaceId, current);
    return { bookingId: booking.id, status: "VISIT_RETURNED" };
  });
  const checkout = repository.listCheckout(workspaceId).find((row) => row.id === input.bookingId && row.paidWith === "credit");
  if (checkout) return repository.transaction(() => {
    renew();
    const current = repository.requireWorkspace(workspaceId).state;
    const booking = current.bookings.find((item) => item.id === input.bookingId);
    const credit = repository.listCredits(workspaceId).find((item) => item.id === checkout.creditId);
    if (!booking || !credit || !credit.redemptions.some((item) => item.bookingId === booking.id)) throw new StoreError(409, "Studio credit redemption not found");
    const recorded = repository.latestMoneyEvents(workspaceId).find((event) => event.kind === "refund" && event.requestId === requestId);
    if (recorded?.status !== "CREDIT_RESTORED") {
      const outstanding = unreturnedRedemption(credit, booking.id);
      const amount = input.partial ? toCents(input.amount) : outstanding;
      if (amount < 0 || amount > outstanding || (input.partial && amount <= 0)) throw new StoreError(409, "Return exceeds redeemed studio credit");
      if (amount > 0) {
        const restorations = credit.restorations ?? [];
        const prior = restorations.find((item) => item.bookingId === booking.id);
        const restoration = { bookingId: booking.id, amount: fromCents(toCents(prior?.amount ?? "0.00") + amount), at: new Date().toISOString() };
        repository.saveCredit({ ...credit, remaining: fromCents(toCents(credit.remaining) + amount), status: "available",
          restorations: [...restorations.filter((item) => item.bookingId !== booking.id), restoration] });
      }
      repository.appendLedger({ workspaceId, bookingId: booking.id, kind: "refund", amount: input.amount, captureId: "", requestId,
        ...(input.partial ? { partial: true } : {}), paypalId: "", status: "CREDIT_RESTORED" });
    }
    if (!input.partial) { booking.status = "refunded"; repository.saveState(workspaceId, current); }
    return { bookingId: booking.id, status: "CREDIT_RESTORED" };
  });
  // Every booking in a concurrent batch is fenced by the same durable workspace lease.
  // Losing it aborts the writer, including error persistence; only fresh PayPal evidence may settle it.
  const fence = async () => {
    try { renew(); }
    catch (error) {
      const current = repository.latestMoneyEvents(workspaceId).find((event) => event.kind === "refund" && event.requestId === requestId);
      if (current && ["REQUESTED", "PENDING", "NEEDS_REVIEW"].includes(current.status)) {
        try { await reconcileRefund(current, repository); } catch { /* Keep the durable reservation. */ }
      }
      throw error;
    }
  };
  let retryAllowed = !previous;
  if (previous && ["REQUESTED", "FAILED", "PENDING", "NEEDS_REVIEW"].includes(previous.status)) {
    const outcome = await reconcileRefund(previous, repository);
    await fence();
    retryAllowed = outcome.kind !== "found" && (outcome.kind === "absent" || (previous.status === "REQUESTED" && canReplayRefund(previous)));
    if (outcome.kind === "unknown") reviewUncertainRefund(previous, repository);
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
      // Fence, re-read and reserve in one write transaction: a writer that lost its lease cannot POST on a stale snapshot.
      const { booking, captureId, ledgerInput, simulated } = repository.transaction(() => {
        renew();
        const booking = repository.requireWorkspace(workspaceId).state.bookings.find((item) => item.id === input.bookingId);
        if (!booking?.payment) throw new Error("Booking has no captured payment");
        const captureId = booking.payment.captureId;
        if (previous && captureId !== previous.captureId) throw new Error("Booking capture changed since the original refund request");
        const money = repository.latestMoneyEvents(workspaceId);
        const capture = money.find((event) => event.kind === "capture" && event.paypalId === captureId);
        const otherRefunds = money.filter((event) => event.kind === "refund" && event.captureId === captureId && event.requestId !== requestId && reserved(event));
        if (booking.status === "refunded" || otherRefunds.some((event) => ["REQUESTED", "PENDING", "NEEDS_REVIEW"].includes(event.status))) throw new Error("Payment already refunded or reserved by another refund");
        if (!capture || !["COMPLETED", "SIMULATED"].includes(capture.status)) throw new Error("Payment capture is not completed");
        if (toCents(input.amount) <= 0 || toCents(input.amount) > toCents(capture.amount) - otherRefunds.reduce((sum, event) => sum + toCents(event.amount), 0)) throw new Error("Refund exceeds captured amount");
        const ledgerInput = { workspaceId, bookingId: booking.id, kind: "refund" as const, amount: input.amount, captureId, requestId, ...(input.partial ? { partial: true } : {}) };
        repository.appendLedger({ ...ledgerInput, paypalId: "", status: "REQUESTED" });
        return { booking, captureId, ledgerInput, simulated: Boolean(booking.payment.simulated) };
      });
      attempted = true;
      const refund = simulated
        ? { id: `SIM-REFUND-${randomUUID()}`, status: "SIMULATED", debugId: undefined }
        : await refundCapture(captureId, input.amount, input.reason, requestId);
      if (!refund.id || !refund.status) throw new Error("Invalid PayPal refund response");
      const settled = repository.transaction(() => {
        renew();
        // A webhook may have completed the refund while the HTTP request was in flight.
        const delivered = repository.latestMoneyEvents(workspaceId).find((event) => event.kind === "refund" && event.requestId === requestId && event.status === "COMPLETED");
        const status = delivered?.status ?? refund.status;
        const event = repository.appendLedger({ ...ledgerInput, paypalId: delivered?.paypalId ?? refund.id, status, debugId: refund.debugId,
          error: status === "FAILED" ? "PayPal reports that this refund failed" : undefined });
        const current = repository.requireWorkspace(workspaceId).state;
        const updated = current.bookings.find((item) => item.id === booking.id)!;
        if (!input.partial) updated.status = ["COMPLETED", "SIMULATED"].includes(event.status) ? "refunded" : "refund_pending";
        repository.saveState(workspaceId, current);
        return event;
      });
      result = { bookingId: booking.id, status: settled.status, paypalId: settled.paypalId, debugId: refund.debugId };
    } catch (error) {
      await fence();
      const debugId = error instanceof PayPalError ? error.debugId : undefined;
      result = repository.transaction(() => {
        renew();
        // Never overwrite a webhook or reconciliation result that landed while this request failed.
        const current = repository.latestMoneyEvents(workspaceId).find((event) => event.kind === "refund" && event.requestId === requestId);
        if (current && ["COMPLETED", "PENDING", "SIMULATED"].includes(current.status)) {
          return { bookingId: input.bookingId, status: current.status, paypalId: current.paypalId || undefined, debugId: current.debugId };
        }
        // Transport, server and in-progress (409) errors have unknown outcomes; retain their reservation.
        // A failed replay says nothing about the original request, so an unresolved original stays reserved.
        const uncertain = !(error instanceof PayPalError) || error.status >= 500 || [408, 409, 429].includes(error.status);
        const status = previous && ["REQUESTED", "PENDING", "NEEDS_REVIEW"].includes(previous.status)
          ? previous.status : attempted && uncertain ? "REQUESTED" : "FAILED";
        const failed: ExecutionResult = { bookingId: input.bookingId, status, error: error instanceof PayPalError ? `${error.name}: ${error.message}` : error instanceof Error ? error.message : "Refund failed", debugId };
        const recorded = repository.appendLedger({ workspaceId, bookingId: input.bookingId, kind: "refund", amount: input.amount,
          captureId: previous?.captureId ?? state.bookings.find((item) => item.id === input.bookingId)?.payment?.captureId ?? "", requestId, ...(input.partial ? { partial: true } : {}), paypalId: previous?.paypalId ?? "", status, debugId, error: failed.error });
        // A retry permitted by positive absence may itself lose its response after the replay window.
        reviewUncertainRefund(recorded, repository);
        const reviewed = repository.latestMoneyEvents(workspaceId).find((event) => event.kind === "refund" && event.requestId === requestId);
        return reviewed?.status === "NEEDS_REVIEW" ? { ...failed, status: reviewed.status, error: reviewed.error } : failed;
      });
    }
  }
  return result;
}
