import { api, json, readBody } from "../../../../lib/api/http";
import { verifyWebhookSignature } from "../../../../lib/paypal/client";
import { processWebhook, WebhookSchema } from "../../../../lib/paypal/webhook";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  return api(async () => {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId) return json({ error: "PayPal webhook is not configured" }, 503);
    const rawBody = await readBody(request, 65_536);
    let body: unknown;
    try { body = JSON.parse(rawBody); }
    catch { return json({ error: "Invalid JSON" }, 400); }
    WebhookSchema.parse(body);
    if (!await verifyWebhookSignature(request.headers, rawBody, webhookId)) return json({ error: "Invalid webhook signature" }, 401);
    return { received: true, ...processWebhook(rawBody) };
  });
}
