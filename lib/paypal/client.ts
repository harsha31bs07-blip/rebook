import { randomUUID } from "node:crypto";
import { ApiError, CheckoutPaymentIntent, Client, Environment, OrdersController, PaymentsController, PaypalExperienceUserAction, TransactionSearchController } from "@paypal/paypal-server-sdk";
import type { ApiResponse, CapturedPayment, OAuthToken, Order, Refund, SearchResponse } from "@paypal/paypal-server-sdk";
import { MoneySchema } from "../domain/schemas";

export class PayPalError extends Error {
  constructor(public status: number, name: string, message: string, public debugId?: string, public issues: string[] = []) {
    super(message);
    this.name = name;
  }
}

export type PayPalPayment = {
  id: string; status: string; amount?: { currency_code: string; value: string }; debugId?: string;
};
export type PayPalOrder = PayPalPayment & {
  purchase_units?: { reference_id?: string; custom_id?: string; amount?: PayPalPayment["amount"]; payments?: { captures?: PayPalPayment[] } }[];
  links?: { rel: string; href: string }[];
};
export type PaymentRefs = { workspaceId: string; bookingId: string; requestId?: string };
type Config = { baseUrl: string; clientId: string; secret: string; key: string };
type Token = { value: string; expiresAt: number };
const tokens = new Map<string, Token>();
const pendingTokens = new Map<string, Promise<Token>>();
let sharedSdk: { key: string; client: Client; authFailure: { error?: unknown } } | undefined;

function sdk(): Client {
  const settings = config();
  if (sharedSdk?.key !== settings.key) {
    let pending: Promise<OAuthToken> | undefined;
    const authFailure: { error?: unknown } = {};
    const client = new Client({
      environment: settings.baseUrl.includes("sandbox") ? Environment.Sandbox : Environment.Production,
      timeout: 20_000,
      clientCredentialsAuthCredentials: {
        oAuthClientId: settings.clientId, oAuthClientSecret: settings.secret, oAuthClockSkew: 60,
        oAuthTokenProvider: async (_lastToken, manager) => {
          // The runtime can enter the provider concurrently. Share a single exchange, and always
          // resolve: a rejected provider promise otherwise poisons this SDK client's auth cache.
          pending ??= manager.fetchToken().then((token) => { authFailure.error = undefined; return token; }, (error) => {
            authFailure.error = error;
            return { accessToken: "", tokenType: "Bearer", expiry: BigInt(0) };
          }).finally(() => { pending = undefined; });
          return pending;
        },
      },
      httpClientOptions: { retryConfig: {
        maxNumberOfRetries: 2, maximumRetryWaitTime: 4, retryInterval: 0.25, backoffFactor: 2,
        retryOnTimeout: false, httpMethodsToRetry: ["GET", "POST"],
        httpStatusCodesToRetry: [429, ...Array.from({ length: 100 }, (_, index) => 500 + index)],
      } },
    });
    const factory = client.getRequestBuilderFactory();
    client.getRequestBuilderFactory = () => (method, path) => {
      const builder = factory(method, path);
      builder.throwOn = new Proxy(builder.throwOn, { apply(target, receiver, args) {
        // Core 0.10 throws explicit endpoint errors inside its retry interceptor, treating them
        // as timeouts. Let transient responses reach the SDK retry policy and default error mapper.
        const status = args[0];
        if (typeof status === "number" && (status === 429 || status >= 500)) return;
        return Reflect.apply(target, receiver, args);
      } });
      return builder;
    };
    sharedSdk = { key: settings.key, client, authFailure };
  }
  return sharedSdk.client;
}

function debugHeader(headers: Record<string, string>): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === "paypal-debug-id")?.[1];
}

async function sdkCall<T>(operation: () => Promise<ApiResponse<T>>): Promise<ApiResponse<T>> {
  try { return await operation(); }
  catch (error) {
    error = sharedSdk?.authFailure.error ?? error;
    // CustomError extends ApiError; unmapped statuses may only have a raw body.
    if (!(error instanceof ApiError)) throw error;
    let body: Record<string, unknown> = {};
    try { body = error.result ?? JSON.parse(typeof error.body === "string" ? error.body : "{}"); } catch { /* Non-JSON upstream error. */ }
    const debugId = debugHeader(error.headers) ?? (typeof body?.debug_id === "string" ? body.debug_id : undefined);
    const mapped = new PayPalError(error.statusCode, typeof body?.name === "string" ? body.name : "PAYPAL_ERROR",
      typeof body?.message === "string" ? body.message : "PayPal request failed", debugId,
      Array.isArray(body?.details) ? body.details.flatMap((detail) => typeof detail?.issue === "string" ? [detail.issue] : []) : []);
    console.error("PayPal request failed", { status: mapped.status, name: mapped.name, debugId });
    throw mapped;
  }
}

function paymentResult(payment: CapturedPayment | Refund): PayPalPayment {
  return { id: payment.id!, status: payment.status!, ...(payment.amount ? {
    amount: { currency_code: payment.amount.currencyCode, value: payment.amount.value },
  } : {}) };
}

function orderResult(response: ApiResponse<Order>): PayPalOrder {
  const order = response.result;
  return { id: order.id!, status: order.status!, debugId: debugHeader(response.headers),
    ...(order.purchaseUnits ? { purchase_units: order.purchaseUnits.map((unit) => ({
      reference_id: unit.referenceId, custom_id: unit.customId,
      ...(unit.amount ? { amount: { currency_code: unit.amount.currencyCode, value: unit.amount.value } } : {}),
      ...(unit.payments ? { payments: { captures: unit.payments.captures?.map(paymentResult) } } : {}),
    })) } : {}),
    ...(order.links ? { links: order.links.map((link) => ({ rel: link.rel, href: link.href })) } : {}),
  };
}

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

const usd = (amount: string) => ({ currencyCode: "USD", value: MoneySchema.parse(amount) });
const purchaseUnits = (amount: string, refs: PaymentRefs) => [{
  referenceId: refs.bookingId, customId: `${refs.workspaceId}:${refs.bookingId}`, amount: usd(amount),
}];

export async function createCardCapture(amount: string, refs: PaymentRefs): Promise<{ orderId: string; captureId: string; status: string; debugId?: string }> {
  // These test card details must never be sent to a live account.
  if ((process.env.PAYPAL_ENV || "sandbox") !== "sandbox") throw new Error("Demo card captures require PayPal sandbox");
  const order = orderResult(await sdkCall(() => new OrdersController(sdk()).createOrder({
    paypalRequestId: refs.requestId ?? `${refs.workspaceId}${refs.bookingId}`, prefer: "return=representation",
    body: { intent: CheckoutPaymentIntent.Capture, purchaseUnits: purchaseUnits(amount, refs), paymentSource: { card: {
      number: "4111111111111111", expiry: "2030-12", securityCode: "123", name: "Rebook Sandbox Member",
      billingAddress: { addressLine1: "123 Main St", adminArea2: "San Jose", adminArea1: "CA", postalCode: "95131", countryCode: "US" },
    } } },
  })));
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture?.id || capture.status !== "COMPLETED") throw new PayPalError(502, "CAPTURE_INCOMPLETE", "Sandbox card capture did not complete", order.debugId);
  return { orderId: order.id, captureId: capture.id, status: capture.status, debugId: order.debugId };
}

export async function createCheckoutOrder(amount: string, refs: PaymentRefs, returnUrl: string, cancelUrl: string): Promise<PayPalOrder> {
  return orderResult(await sdkCall(() => new OrdersController(sdk()).createOrder({
    paypalRequestId: refs.requestId ?? `${refs.workspaceId}${refs.bookingId}`, prefer: "return=representation",
    body: { intent: CheckoutPaymentIntent.Capture, purchaseUnits: purchaseUnits(amount, refs), paymentSource: { paypal: {
      experienceContext: { returnUrl, cancelUrl, userAction: PaypalExperienceUserAction.PayNow },
    } } } })));
}

export async function captureOrder(orderId: string, requestId: string): Promise<PayPalOrder> {
  return orderResult(await sdkCall(() => new OrdersController(sdk()).captureOrder({
    id: orderId, paypalRequestId: requestId, prefer: "return=representation", body: {},
  })));
}

/** No payment source: the v6 wallet or card session supplies the buyer's choice. */
export async function createBookingOrder(amount: string, refs: PaymentRefs & { requestId: string }, description: string): Promise<PayPalOrder> {
  return orderResult(await sdkCall(() => new OrdersController(sdk()).createOrder({
    paypalRequestId: refs.requestId, prefer: "return=representation",
    body: { intent: CheckoutPaymentIntent.Capture,
      purchaseUnits: purchaseUnits(amount, refs).map((unit) => ({ ...unit, description: description.slice(0, 127) })) },
  })));
}

export async function getOrder(orderId: string): Promise<PayPalOrder> {
  return orderResult(await sdkCall(() => new OrdersController(sdk()).getOrder({ id: orderId })));
}

/** Expired create-order keys are never replayed. Search is read-only and may lag or lack permission. */
export async function lookupCardCapture(amount: string, refs: PaymentRefs, firstAttemptAt: string): Promise<{ orderId: string; captureId: string; status: string; debugId?: string } | undefined> {
  try {
    const start = Date.parse(firstAttemptAt);
    const transactions = await listTransactions(new Date(start - 60_000).toISOString(), new Date(Math.min(Date.now(), start + 6 * 3_600_000)).toISOString());
    const matches = (transactions.transactionDetails ?? []).flatMap((detail) => {
      const info = detail.transactionInfo;
      return info?.customField === `${refs.workspaceId}:${refs.bookingId}` && info.transactionStatus === "S" &&
        info.transactionAmount?.currencyCode === "USD" && info.transactionAmount.value === amount && info.transactionId ? [info] : [];
    });
    if (matches.length !== 1) return;
    const info = matches[0];
    if (info.paypalReferenceIdType === "ODR" && info.paypalReferenceId) {
      const order = await getOrder(info.paypalReferenceId);
      const unit = order.purchase_units?.find((unit) => unit.custom_id === `${refs.workspaceId}:${refs.bookingId}` && unit.reference_id === refs.bookingId);
      const capture = unit?.payments?.captures?.find((capture) => capture.id === info.transactionId);
      if (capture?.status === "COMPLETED" && capture.amount?.currency_code === "USD" && capture.amount.value === amount) {
        return { orderId: order.id, captureId: capture.id, status: capture.status };
      }
      return;
    }
    const capture = await getCapture(info.transactionId!);
    if (capture.id === info.transactionId && capture.status === "COMPLETED" && capture.amount?.currency_code === "USD" && capture.amount.value === amount) {
      return { orderId: "", captureId: capture.id, status: capture.status };
    }
  } catch { /* Unavailable or inconclusive evidence becomes a visible simulated fallback. */ }
}

export async function refundCapture(captureId: string, amount: string, note: string, requestId: string): Promise<PayPalPayment> {
  const response = await sdkCall(() => new PaymentsController(sdk()).refundCapturedPayment({
    captureId, paypalRequestId: requestId, prefer: "return=representation",
    body: { amount: usd(amount), noteToPayer: note.slice(0, 255), invoiceId: requestId },
  }));
  return { ...paymentResult(response.result), debugId: debugHeader(response.headers) };
}

export async function getCapture(captureId: string): Promise<PayPalPayment> {
  const response = await sdkCall(() => new PaymentsController(sdk()).getCapturedPayment({ captureId }));
  return { ...paymentResult(response.result), debugId: debugHeader(response.headers) };
}

export async function listTransactions(startIso: string, endIso: string): Promise<SearchResponse> {
  const start = Date.parse(startIso), end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 31 * 86_400_000) {
    throw new Error("Transaction window must be positive and at most 31 days");
  }
  const seconds = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
  const result: SearchResponse = { transactionDetails: [] };
  for (let page = 1; ; page += 1) {
    const response = await sdkCall(() => new TransactionSearchController(sdk()).searchTransactions({
      startDate: seconds(start), endDate: seconds(end), fields: "all", pageSize: 500, page,
    }));
    result.transactionDetails!.push(...(response.result.transactionDetails ?? []));
    if (page >= (response.result.totalPages ?? 1)) return { ...response.result, transactionDetails: result.transactionDetails };
  }
}

export async function verifyWebhookSignature(headers: Headers, rawBody: string, webhookId: string): Promise<boolean> {
  // Server SDK 2.5.0 has no webhook verification endpoint; keep this call on fetch.
  const fields = { auth_algo: headers.get("paypal-auth-algo"), cert_url: headers.get("paypal-cert-url"),
    transmission_id: headers.get("paypal-transmission-id"), transmission_sig: headers.get("paypal-transmission-sig"),
    transmission_time: headers.get("paypal-transmission-time") };
  if (!webhookId || Object.values(fields).some((value) => !value)) return false;
  const result = await request<{ verification_status: string }>("/v1/notifications/verify-webhook-signature", {
    body: { ...fields, webhook_id: webhookId, webhook_event: JSON.parse(rawBody) },
  });
  return result.verification_status === "SUCCESS";
}
