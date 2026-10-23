import { randomUUID } from "node:crypto";
import { MoneySchema } from "../domain/schemas";

export class PayPalError extends Error {
  constructor(public status: number, name: string, message: string, public debugId?: string) {
    super(message);
    this.name = name;
  }
}

export type PayPalPayment = {
  id: string; status: string; amount?: { currency_code: string; value: string }; debugId?: string;
};
export type PayPalOrder = PayPalPayment & {
  purchase_units?: { payments?: { captures?: PayPalPayment[] } }[];
  links?: { rel: string; href: string }[];
};
export type PaymentRefs = { workspaceId: string; bookingId: string; requestId?: string };
type Config = { baseUrl: string; clientId: string; secret: string; key: string };
type Token = { value: string; expiresAt: number };
const tokens = new Map<string, Token>();
const pendingTokens = new Map<string, Promise<Token>>();

function config(): Config {
  const environment = process.env.PAYPAL_ENV || "sandbox";
  if (environment !== "sandbox" && environment !== "live") throw new Error("PAYPAL_ENV must be sandbox or live");
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error("PayPal credentials are not configured");
  const baseUrl = environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  return { baseUrl, clientId, secret, key: `${baseUrl}:${clientId}:${secret}` };
}

async function send(url: string, init: RequestInit): Promise<Response> {
  // Three attempts total. Every retry reuses the exact request body and idempotency key.
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if ((response.status !== 429 && response.status < 500) || attempt === 2) return response;
    const retryAfter = response.headers.get("retry-after");
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : 250 * 2 ** attempt;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, Math.min(2000, Math.max(0, delay))));
  }
}

async function read<T>(response: Response): Promise<T> {
  const debugId = response.headers.get("paypal-debug-id") ?? undefined;
  const parsed = await response.json().catch(() => ({}));
  const body = parsed && typeof parsed === "object" ? parsed : {};
  if (!response.ok) {
    const error = new PayPalError(response.status, typeof body.name === "string" ? body.name : "PAYPAL_ERROR",
      typeof body.message === "string" ? body.message : "PayPal request failed", debugId);
    console.error("PayPal request failed", { status: error.status, name: error.name, debugId });
    throw error;
  }
  return { ...body, ...(debugId ? { debugId } : {}) } as T;
}

async function accessToken(settings: Config): Promise<string> {
  const cached = tokens.get(settings.key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  let pending = pendingTokens.get(settings.key);
  if (!pending) {
    pending = (async () => {
      const response = await send(`${settings.baseUrl}/v1/oauth2/token`, {
        method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${settings.clientId}:${settings.secret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials",
      });
      const body = await read<{ access_token: string; expires_in: number }>(response);
      if (!body.access_token || !Number.isFinite(body.expires_in)) throw new Error("Invalid PayPal token response");
      const token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
      tokens.set(settings.key, token);
      return token;
    })();
    pendingTokens.set(settings.key, pending);
  }
  try { return (await pending).value; }
  finally { pendingTokens.delete(settings.key); }
}

export async function request<T>(path: string, options: { method?: "GET" | "POST"; body?: unknown; requestId?: string } = {}): Promise<T> {
  if (!path.startsWith("/v1/") && !path.startsWith("/v2/")) throw new Error("Invalid PayPal API path");
  const settings = config();
  const token = await accessToken(settings);
  const method = options.method ?? "POST";
  const requestId = options.requestId ?? (method === "POST" ? randomUUID() : undefined);
  const response = await send(`${settings.baseUrl}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation",
      ...(requestId ? { "PayPal-Request-Id": requestId } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  return read<T>(response);
}

const usd = (amount: string) => ({ currency_code: "USD", value: MoneySchema.parse(amount) });
const purchaseUnits = (amount: string, refs: PaymentRefs) => [{
  reference_id: refs.bookingId, custom_id: `${refs.workspaceId}:${refs.bookingId}`, amount: usd(amount),
}];

export async function createCardCapture(amount: string, refs: PaymentRefs): Promise<{ orderId: string; captureId: string; status: string; debugId?: string }> {
  // These test card details must never be sent to a live account.
  if ((process.env.PAYPAL_ENV || "sandbox") !== "sandbox") throw new Error("Demo card captures require PayPal sandbox");
  const order = await request<PayPalOrder>("/v2/checkout/orders", {
    requestId: refs.requestId ?? `${refs.workspaceId}${refs.bookingId}`,
    body: { intent: "CAPTURE", purchase_units: purchaseUnits(amount, refs), payment_source: { card: {
      number: "4111111111111111", expiry: "2030-12", security_code: "123", name: "Rebook Sandbox Member",
      billing_address: { address_line_1: "123 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
    } } },
  });
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture?.id || capture.status !== "COMPLETED") throw new PayPalError(502, "CAPTURE_INCOMPLETE", "Sandbox card capture did not complete", order.debugId);
  return { orderId: order.id, captureId: capture.id, status: capture.status, debugId: order.debugId };
}

export function createCheckoutOrder(amount: string, refs: PaymentRefs, returnUrl: string, cancelUrl: string): Promise<PayPalOrder> {
  return request("/v2/checkout/orders", { requestId: refs.requestId ?? `${refs.workspaceId}${refs.bookingId}`,
    body: { intent: "CAPTURE", purchase_units: purchaseUnits(amount, refs), payment_source: { paypal: {
      experience_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: "PAY_NOW" },
    } } } });
}

export function captureOrder(orderId: string, requestId: string): Promise<PayPalOrder> {
  return request(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { requestId, body: {} });
}

export function refundCapture(captureId: string, amount: string, note: string, requestId: string): Promise<PayPalPayment> {
  return request(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, { requestId,
    body: { amount: usd(amount), note_to_payer: note.slice(0, 255), invoice_id: requestId } });
}

export function getCapture(captureId: string): Promise<PayPalPayment> {
  return request(`/v2/payments/captures/${encodeURIComponent(captureId)}`, { method: "GET" });
}

export async function verifyWebhookSignature(headers: Headers, rawBody: string, webhookId: string): Promise<boolean> {
  const fields = { auth_algo: headers.get("paypal-auth-algo"), cert_url: headers.get("paypal-cert-url"),
    transmission_id: headers.get("paypal-transmission-id"), transmission_sig: headers.get("paypal-transmission-sig"),
    transmission_time: headers.get("paypal-transmission-time") };
  if (!webhookId || Object.values(fields).some((value) => !value)) return false;
  const result = await request<{ verification_status: string }>("/v1/notifications/verify-webhook-signature", {
    body: { ...fields, webhook_id: webhookId, webhook_event: JSON.parse(rawBody) },
  });
  return result.verification_status === "SUCCESS";
}
