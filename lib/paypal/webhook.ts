import { z } from "zod";
import { MoneySchema } from "../domain/schemas";
import { toCents } from "../domain/time";
import { getRepository, type Repository } from "../store";
import { confirmOrder } from "../checkout/service";
import { matchingRefund } from "./refund-evidence";

export const WebhookSchema = z.object({
  id: z.string().min(1), event_type: z.string().min(1),
  resource: z.object({
    id: z.string().min(1), status: z.string().optional(),
    amount: z.object({ currency_code: z.literal("USD"), value: MoneySchema }).optional(),
    capture_id: z.string().optional(),
    custom_id: z.string().optional(),
    supplementary_data: z.object({ related_ids: z.object({ capture_id: z.string().optional(), order_id: z.string().optional() }).optional() }).optional(),
    links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
  }).passthrough(),
}).passthrough();

type WebhookOutcome = "matched_capture" | "matched_refund" | "matched_reversal" | "ignored" | "duplicate";
export type WebhookDeliveryResult = {
  verification: string; outcome: WebhookOutcome | "rejected" | "error"; reason?: string; errorClass?: string;
};

/** Only allowlisted identifiers and outcomes go to logs; never headers or payloads. */
export function logWebhookDelivery(body: unknown, result: WebhookDeliveryResult): void {
  const event = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const resource = event.resource && typeof event.resource === "object" ? event.resource as Record<string, unknown> : {};
  const identifier = (value: unknown) => typeof value === "string" ? value.slice(0, 200) : null;
  console.info(JSON.stringify({
    message: "paypal_webhook_delivery", eventId: identifier(event.id), eventType: identifier(event.event_type), resourceId: identifier(resource.id),
    environment: process.env.PAYPAL_ENV || "sandbox", ...result,
  }));
}

/** Called only after PayPal's signature verification succeeds. Event insertion and updates are atomic. */
export function processWebhook(rawBody: string, repository: Repository = getRepository()): { duplicate: boolean; matched: boolean; outcome: WebhookOutcome; reason?: string } {
  const event = WebhookSchema.parse(JSON.parse(rawBody));
  const result = repository.transaction(() => {
    if (!repository.recordWebhook(event.id, rawBody)) return { duplicate: true, matched: false };
    const statuses: Record<string, string> = {
      "PAYMENT.CAPTURE.REFUNDED": "COMPLETED", "PAYMENT.CAPTURE.COMPLETED": "COMPLETED", "PAYMENT.CAPTURE.REVERSED": "REVERSED",
    };
    const status = statuses[event.event_type];
    if (!status) return { duplicate: false, matched: false, reason: "unsupported_event_type" };
    const resource = event.resource;
    const captureLink = resource.links?.map((link) => link.href.match(/\/v2\/payments\/captures\/([^/?#]+)/)?.[1]).find(Boolean);
    const captureId = resource.capture_id ?? resource.supplementary_data?.related_ids?.capture_id ?? captureLink;
    const match = repository.findPayment(resource.id, captureId);
    if (!match) {
      // The webhook can beat the capture response (or recover a process crash after PayPal charged).
      const orderId = resource.supplementary_data?.related_ids?.order_id;
      const pending = orderId ? repository.findCheckoutOrder(orderId) : undefined;
      if (event.event_type === "PAYMENT.CAPTURE.COMPLETED" && resource.status === "COMPLETED" && pending?.status === "capturing"
        && resource.custom_id === (pending.paypalCustomId ?? `${pending.workspaceId}:${pending.id}`) && resource.amount?.value === pending.amount) {
        confirmOrder(pending, { id: orderId!, status: "COMPLETED", purchase_units: [{ reference_id: pending.id, custom_id: resource.custom_id,
          amount: resource.amount, payments: { captures: [{ id: resource.id, status: "COMPLETED", amount: resource.amount }] } }] }, repository, true, true);
        return { duplicate: false, matched: true };
      }
      return { duplicate: false, matched: false, reason: "unmatched_payment" };
    }
    // Private pool captures still receive PayPal events before a visitor claims them.
    const workspace = repository.requireWorkspace(match.workspaceId, true);
    const latest = repository.latestMoneyEvents(workspace.id);
    const capture = latest.find((item) => item.kind === "capture" && item.captureId === match.captureId);
    if (!capture || capture.status === "SIMULATED") return { duplicate: false, matched: false, reason: "missing_or_simulated_capture" };
    const booking = workspace.state.bookings.find((item) => item.id === capture.bookingId && item.payment?.captureId === capture.captureId);
    if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
      const checkout = booking?.payment ? repository.checkoutByOrder(workspace.id, booking.payment.orderId) : undefined;
      if (checkout) {
        if (resource.id !== checkout.captureId || resource.status !== "COMPLETED" || resource.amount?.value !== checkout.amount
          || (resource.custom_id !== undefined && resource.custom_id !== (checkout.paypalCustomId ?? `${workspace.id}:${checkout.id}`))) return { duplicate: false, matched: false, reason: "capture_mismatch" };
        repository.saveCheckout({ ...checkout, webhookConfirmed: true });
      }
    }
    if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
      const evidence = { ...resource, status };
      const exact = latest.find((item) => item.kind === "refund" && item.paypalId === resource.id);
      const matchesExact = exact && (exact.requestId === `webhook:${resource.id}`
        ? resource.amount?.value === exact.amount : matchingRefund(evidence, exact));
      if (exact && (exact.captureId !== capture.captureId || !matchesExact)) return { duplicate: false, matched: false, reason: "refund_mismatch" };
      const byRequest = latest.find((item) => item.kind === "refund" && item.captureId === capture.captureId &&
        ["REQUESTED", "PENDING", "NEEDS_REVIEW"].includes(item.status) && matchingRefund(evidence, item));
      const previousRefund = exact && exact.requestId !== `webhook:${resource.id}` ? exact : byRequest ?? exact;
      const amount = resource.amount?.value ?? previousRefund?.amount;
      if (!amount || toCents(amount) > toCents(capture.amount)) return { duplicate: false, matched: false, reason: "invalid_refund_amount" };
      const otherRefunded = latest.filter((item) => item.kind === "refund" && item.captureId === capture.captureId && item.status === "COMPLETED" && item.requestId !== previousRefund?.requestId && item.paypalId !== resource.id)
        .reduce((sum, item) => sum + toCents(item.amount), 0);
      if (otherRefunded + toCents(amount) > toCents(capture.amount)) return { duplicate: false, matched: false, reason: "refund_exceeds_capture" };
      repository.appendLedger({ workspaceId: workspace.id, bookingId: capture.bookingId, kind: "refund", amount,
        paypalId: resource.id, captureId: capture.captureId, requestId: previousRefund?.requestId ?? `webhook:${resource.id}`, status,
        ...(previousRefund?.partial ? { partial: true } : {}) });
      if (booking && !previousRefund?.partial) {
        if (otherRefunded + toCents(amount) >= toCents(capture.amount)) booking.status = "refunded";
        else if (previousRefund && previousRefund.requestId !== `webhook:${resource.id}`) booking.status = "refund_pending";
      }
    } else {
      // A late completion event must not undo a reversal or a booking's refund state.
      if (capture.status !== "REVERSED" || status === "REVERSED") repository.appendLedger({ ...capture, status });
      if (booking && status === "REVERSED" && booking.status !== "refunded") booking.status = "cancelled";
    }
    repository.saveState(workspace.id, workspace.state);
    return { duplicate: false, matched: true };
  });
  return { ...result, outcome: result.duplicate ? "duplicate" : !result.matched ? "ignored"
    : event.event_type === "PAYMENT.CAPTURE.REFUNDED" ? "matched_refund"
      : event.event_type === "PAYMENT.CAPTURE.REVERSED" ? "matched_reversal" : "matched_capture" };
}
