import { api, json, readBody } from "../../../../lib/api/http";
import { verifyWebhookSignature } from "../../../../lib/paypal/client";
import { logWebhookDelivery, processWebhook, WebhookSchema, type WebhookDeliveryResult } from "../../../../lib/paypal/webhook";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  return api(async () => {
    let body: unknown;
    const delivery: WebhookDeliveryResult = { verification: "NOT_ATTEMPTED", outcome: "rejected", reason: "invalid_body" };
    let verifying = false;
    try {
      const rawBody = await readBody(request, 65_536);
      try { body = JSON.parse(rawBody); }
      catch {
        delivery.reason = "invalid_json";
        return json({ error: "Invalid JSON" }, 400);
      }
      const webhookId = process.env.PAYPAL_WEBHOOK_ID;
      if (!webhookId) {
        delivery.reason = "webhook_not_configured";
        return json({ error: "PayPal webhook is not configured" }, 503);
      }
      // Validate for processing, but pass the untouched body to signature verification.
      WebhookSchema.parse(body);
      verifying = true;
      const verified = await verifyWebhookSignature(request.headers, rawBody, webhookId);
      verifying = false;
      delivery.verification = verified ? "VERIFIED" : "FAILURE";
      if (!verified) {
        delivery.reason = "invalid_signature_or_missing_headers";
        return json({ error: "Invalid webhook signature" }, 401);
      }
      const result = processWebhook(rawBody);
      delivery.outcome = result.outcome;
      delivery.reason = result.reason;
      return { received: true, ...result };
    } catch (error) {
      const errorClass = error instanceof Error ? error.constructor.name : "UnknownError";
      delivery.errorClass = errorClass;
      if (verifying) delivery.verification = errorClass;
      delivery.outcome = "error";
      delivery.reason = verifying ? "verification_error" : delivery.verification === "VERIFIED" ? "processing_error" : "invalid_body";
      throw error;
    } finally {
      logWebhookDelivery(body, delivery);
    }
  });
}
