import { Client, Environment, PaymentsController } from "@paypal/paypal-server-sdk";
import type { ApiResponse, CapturedPayment, Refund } from "@paypal/paypal-server-sdk";
import { z } from "zod";
import { MoneySchema } from "../domain/schemas";
import type { PayPalPayment } from "../paypal/client";
import type { LedgerEvent, Repository } from "../store";

const Evidence = z.object({
  id: z.string(), status: z.string(), invoice_id: z.string().optional(), request_id: z.string().optional(),
  paypal_request_id: z.string().optional(), note_to_payer: z.string().optional(),
  amount: z.object({ currency_code: z.literal("USD"), value: MoneySchema }).optional(),
});
type Reconciliation = { kind: "found"; payment: PayPalPayment } | { kind: "absent" } | { kind: "unknown" };

function body(response: ApiResponse<CapturedPayment | Refund>): Record<string, unknown> {
  // Capture's SDK schema omits refund collections. Inspect the original response without
  // altering the installed SDK or following arbitrary upstream URLs.
  if (typeof response.body !== "string") return {};
  const value: unknown = JSON.parse(response.body);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function payment(response: ApiResponse<Refund>): PayPalPayment {
  const value = response.result;
  if (!value.id || !value.status) throw new Error("Incomplete PayPal refund details");
  return { id: value.id, status: value.status, amount: value.amount && { currency_code: value.amount.currencyCode, value: value.amount.value } };
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
      const found = payment(await controller.getRefund({ refundId: event.paypalId }));
      if (found.id !== event.paypalId || (found.amount && (found.amount.currency_code !== "USD" || found.amount.value !== event.amount))) return { kind: "unknown" };
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
      const parsed = Evidence.safeParse(candidate);
      if (!parsed.success) continue;
      const refund = parsed.data;
      if (![refund.invoice_id, refund.request_id, refund.paypal_request_id, refund.note_to_payer].includes(event.requestId)) continue;
      if (refund.amount && refund.amount.value !== event.amount) return { kind: "unknown" };
      return { kind: "found", payment: { id: refund.id, status: refund.status, amount: refund.amount } };
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
  repository.transaction(() => {
    repository.appendLedger({ ...event, paypalId, status,
      error: status === "FAILED" ? "PayPal reports that this refund failed" : undefined });
    const workspace = repository.requireWorkspace(event.workspaceId, true);
    const booking = workspace.state.bookings.find((item) => item.id === event.bookingId && item.payment?.captureId === event.captureId);
    if (booking) {
      booking.status = status === "COMPLETED" ? "refunded" : "refund_pending";
      repository.saveState(workspace.id, workspace.state);
    }
  });
  return { kind: "found", payment: { ...outcome.payment, id: paypalId, status } };
}
