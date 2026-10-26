import { Client, Environment, PaymentsController } from "@paypal/paypal-server-sdk";
import type { ApiResponse, CapturedPayment, Refund } from "@paypal/paypal-server-sdk";
import type { PayPalPayment } from "../paypal/client";
import type { LedgerEvent, Repository } from "../store";
import { matchingRefund } from "../paypal/refund-evidence";
type Reconciliation = { kind: "found"; payment: PayPalPayment } | { kind: "absent" } | { kind: "unknown" };

function body(response: ApiResponse<CapturedPayment | Refund>): Record<string, unknown> {
  // Capture's SDK schema omits refund collections. Inspect the original response without
  // altering the installed SDK or following arbitrary upstream URLs.
  if (typeof response.body !== "string") return {};
  const value: unknown = JSON.parse(response.body);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Read-only SDK reconciliation, isolated from the refund writer and its retry policy. */
export async function lookupRefund(event: LedgerEvent): Promise<Reconciliation> {
  const environment = process.env.PAYPAL_ENV || "sandbox";
  const clientId = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!["sandbox", "live"].includes(environment) || !clientId || !secret) return { kind: "unknown" };
  // A short-lived read client also avoids retaining a rejected SDK OAuth promise across retries.
  const controller = new PaymentsController(new Client({
    environment: environment === "live" ? Environment.Production : Environment.Sandbox, timeout: 20_000,
    clientCredentialsAuthCredentials: { oAuthClientId: clientId, oAuthClientSecret: secret },
    httpClientOptions: { retryConfig: { maxNumberOfRetries: 0, retryOnTimeout: false } },
  }));
  try {
    if (event.paypalId) {
      const found = matchingRefund(body(await controller.getRefund({ refundId: event.paypalId })), event);
      if (!found) return { kind: "unknown" };
      return { kind: "found", payment: found };
    }
    const response = await controller.getCapturedPayment({ captureId: event.captureId });
    if (response.result.id !== event.captureId) return { kind: "unknown" };
    const raw = body(response);
    const candidates: unknown[] = Array.isArray(raw.refunds) ? [...raw.refunds] : [];
    for (const link of response.result.links ?? []) {
      const id = link.href.match(/\/v2\/payments\/refunds\/([^/?#]+)(?:[?#].*)?$/)?.[1];
      if (id) candidates.push(body(await controller.getRefund({ refundId: id })));
    }
    for (const candidate of candidates) {
      const found = matchingRefund(candidate, event);
      if (found) return { kind: "found", payment: found };
    }
    // An unrefunded completed capture is positive evidence for retrying a rejected request.
    return response.result.status === "COMPLETED" && candidates.length === 0 ? { kind: "absent" } : { kind: "unknown" };
  } catch { return { kind: "unknown" }; }
}

/** Used by execution and reset. Unknown outcomes never release the money reservation. */
export async function reconcileRefund(event: LedgerEvent, repository: Repository): Promise<Reconciliation> {
  const outcome = await lookupRefund(event);
  if (outcome.kind !== "found") return outcome;
  const delivered = repository.latestMoneyEvents(event.workspaceId).find((item) => item.kind === "refund" && item.requestId === event.requestId);
  const status = delivered?.status === "COMPLETED" ? "COMPLETED" : outcome.payment.status;
  const paypalId = delivered?.status === "COMPLETED" ? delivered.paypalId : outcome.payment.id;
  const settled = repository.transaction(() => {
    const recorded = repository.appendLedger({ ...event, paypalId, status,
      error: status === "FAILED" ? "PayPal reports that this refund failed" : undefined });
    const workspace = repository.requireWorkspace(event.workspaceId, true);
    const booking = workspace.state.bookings.find((item) => item.id === event.bookingId && item.payment?.captureId === event.captureId);
    if (booking && !event.partial) {
      booking.status = recorded.status === "COMPLETED" ? "refunded" : "refund_pending";
      repository.saveState(workspace.id, workspace.state);
    }
    return recorded;
  });
  return { kind: "found", payment: { ...outcome.payment, id: settled.paypalId, status: settled.status } };
}
