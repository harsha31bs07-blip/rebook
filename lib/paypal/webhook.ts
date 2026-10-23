import { z } from "zod";
import { MoneySchema } from "../domain/schemas";
import { toCents } from "../domain/time";
import { getRepository, type Repository } from "../store";

export const WebhookSchema = z.object({
  id: z.string().min(1), event_type: z.string().min(1),
  resource: z.object({
    id: z.string().min(1), status: z.string().optional(),
    amount: z.object({ currency_code: z.literal("USD"), value: MoneySchema }).optional(),
    capture_id: z.string().optional(),
    supplementary_data: z.object({ related_ids: z.object({ capture_id: z.string().optional() }).optional() }).optional(),
    links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
  }).passthrough(),
}).passthrough();

/** Called only after PayPal's signature verification succeeds. Event insertion and updates are atomic. */
export function processWebhook(rawBody: string, repository: Repository = getRepository()): { duplicate: boolean; matched: boolean } {
  const event = WebhookSchema.parse(JSON.parse(rawBody));
  return repository.transaction(() => {
    if (!repository.recordWebhook(event.id, rawBody)) return { duplicate: true, matched: false };
    const statuses: Record<string, string> = {
      "PAYMENT.CAPTURE.REFUNDED": "COMPLETED", "PAYMENT.CAPTURE.COMPLETED": "COMPLETED", "PAYMENT.CAPTURE.REVERSED": "REVERSED",
    };
    const status = statuses[event.event_type];
    if (!status) return { duplicate: false, matched: false };
    const resource = event.resource;
    const captureLink = resource.links?.map((link) => link.href.match(/\/v2\/payments\/captures\/([^/?#]+)/)?.[1]).find(Boolean);
    const captureId = resource.capture_id ?? resource.supplementary_data?.related_ids?.capture_id ?? captureLink;
    const match = repository.findPayment(resource.id, captureId);
    if (!match) return { duplicate: false, matched: false };
    const workspace = repository.requireWorkspace(match.workspaceId);
    const latest = repository.latestMoneyEvents(workspace.id);
    const capture = latest.find((item) => item.kind === "capture" && item.captureId === match.captureId);
    if (!capture || capture.status === "SIMULATED") return { duplicate: false, matched: false };
    const booking = workspace.state.bookings.find((item) => item.id === capture.bookingId && item.payment?.captureId === capture.captureId);
    if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
      const previousRefund = latest.find((item) => item.kind === "refund" && item.paypalId === resource.id)
        ?? latest.find((item) => item.kind === "refund" && item.captureId === capture.captureId && ["REQUESTED", "PENDING"].includes(item.status));
      const amount = resource.amount?.value ?? previousRefund?.amount;
      if (!amount || toCents(amount) > toCents(capture.amount)) return { duplicate: false, matched: false };
      const otherRefunded = latest.filter((item) => item.kind === "refund" && item.captureId === capture.captureId && item.status === "COMPLETED" && item.requestId !== previousRefund?.requestId)
        .reduce((sum, item) => sum + toCents(item.amount), 0);
      if (otherRefunded + toCents(amount) > toCents(capture.amount)) return { duplicate: false, matched: false };
      repository.appendLedger({ workspaceId: workspace.id, bookingId: capture.bookingId, kind: "refund", amount,
        paypalId: resource.id, captureId: capture.captureId, requestId: previousRefund?.requestId ?? `webhook:${resource.id}`, status });
      if (booking) booking.status = otherRefunded + toCents(amount) >= toCents(capture.amount) ? "refunded" : "refund_pending";
    } else {
      // A late completion event must not undo a reversal or a booking's refund state.
      if (capture.status !== "REVERSED" || status === "REVERSED") repository.appendLedger({ ...capture, status });
      if (booking && status === "REVERSED" && booking.status !== "refunded") booking.status = "cancelled";
    }
    repository.saveState(workspace.id, workspace.state);
    return { duplicate: false, matched: true };
  });
}
