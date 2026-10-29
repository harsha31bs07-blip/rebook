import { fromCents, toCents } from "../domain/time";
import type { Credit, Repository } from "../store";

/** Refund reservations reduce backing before PayPal settlement; reversals remove it entirely. */
export function remainingCaptured(workspaceId: string, bookingId: string, repository: Repository): number {
  const { state } = repository.requireReadyWorkspace(workspaceId);
  const booking = state.bookings.find((item) => item.id === bookingId);
  const money = repository.latestMoneyEvents(workspaceId);
  if (money.some((event) => event.kind === "capture" && event.captureId === booking?.payment?.captureId && event.status === "REVERSED")) return 0;
  const capture = money.find((event) => event.kind === "capture" && event.paypalId === booking?.payment?.captureId);
  if (!capture || !["COMPLETED", "SIMULATED"].includes(capture.status)) return 0;
  return Math.max(0, toCents(capture.amount) - money
    .filter((event) => event.kind === "refund" && event.captureId === capture.captureId && ["REQUESTED", "PENDING", "NEEDS_REVIEW", "COMPLETED", "SIMULATED"].includes(event.status))
    .reduce((sum, event) => sum + toCents(event.amount), 0));
}

export function unreturnedRedemption(credit: Credit, bookingId: string): number {
  return Math.max(0, credit.redemptions.filter((item) => item.bookingId === bookingId).reduce((sum, item) => sum + toCents(item.amount), 0)
    - (credit.restorations ?? []).filter((item) => item.bookingId === bookingId).reduce((sum, item) => sum + toCents(item.amount), 0));
}

/** Inspection never rewrites the stored balance or money ledger. Call inside the redemption transaction. */
export function spendableCredit(credit: Credit, repository: Repository) {
  const backing = remainingCaptured(credit.workspaceId, credit.bookingId, repository);
  const redeemed = credit.redemptions.reduce((sum, item) => sum + toCents(item.amount), 0)
    - (credit.restorations ?? []).reduce((sum, item) => sum + toCents(item.amount), 0);
  const balance = toCents(credit.remaining);
  const remaining = Math.max(0, Math.min(balance, backing - redeemed));
  const status: Credit["status"] = remaining > 0 ? "available" : backing < balance + redeemed ? "unavailable" : "redeemed";
  return { amount: credit.amount, remaining: fromCents(remaining), status };
}
