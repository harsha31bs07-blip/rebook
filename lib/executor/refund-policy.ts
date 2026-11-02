import type { LedgerEvent, Repository } from "../store";

// Deliberately far inside PayPal's refund idempotency retention (up to 45 days).
// https://developer.paypal.com/api/rest/requests/
export const REFUND_REPLAY_WINDOW_MS = 60 * 60_000;
export const REFUND_REVIEW_MESSAGE = "PayPal may already have issued this refund. Needs review: automatic retry is paused to avoid a duplicate. Check with PayPal before retrying.";

export function canReplayRefund(event: LedgerEvent, now = Date.now()): boolean {
  const age = now - Date.parse(event.firstAttemptAt ?? event.createdAt);
  return Number.isFinite(age) && age >= 0 && age < REFUND_REPLAY_WINDOW_MS;
}

/** Unknown money stays reserved, including when an owner must investigate it. */
export function reviewUncertainRefund(event: LedgerEvent, repository: Repository): void {
  if (!["REQUESTED", "NEEDS_REVIEW"].includes(event.status) || canReplayRefund(event)) return;
  repository.transaction(() => {
    const current = repository.latestMoneyEvents(event.workspaceId).find((item) => item.kind === "refund" && item.requestId === event.requestId);
    if (current?.id === event.id) repository.appendLedger({ ...current, status: "NEEDS_REVIEW", error: REFUND_REVIEW_MESSAGE });
  });
}
