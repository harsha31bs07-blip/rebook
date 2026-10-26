import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/paypal/webhook/route";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import { seedStudio } from "../lib/seed/seed";
import { processWebhook } from "../lib/paypal/webhook";

let directory: string;
let repository: Repository;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rebook-webhook-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  vi.stubEnv("PAYPAL_CLIENT_ID", randomUUID());
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "mock-secret");
  vi.stubEnv("PAYPAL_WEBHOOK_ID", "webhook-id");
  repository = getRepository();
});
afterEach(() => {
  closeRepository(); rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const signatureHeaders = { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/cert", "paypal-transmission-id": "transmission", "paypal-transmission-sig": "signature", "paypal-transmission-time": "2026-10-23T12:00:00Z" };
function eventRequest(body: unknown) {
  return new Request("http://localhost/api/paypal/webhook", { method: "POST", headers: signatureHeaders, body: JSON.stringify(body) });
}
function verification(verified: boolean) {
  const fetch = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/token")
    ? Response.json({ access_token: "token", expires_in: 3600 })
    : Response.json({ verification_status: verified ? "SUCCESS" : "FAILURE" }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function prepared() {
  const state = seedStudio();
  const booking = state.bookings[0];
  booking.payment = { orderId: "order", captureId: "capture", simulated: false };
  booking.status = "refund_pending";
  const workspace = repository.createWorkspace(state);
  repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "capture", amount: booking.amount,
    paypalId: "capture", captureId: "capture", requestId: "capture-request", status: "COMPLETED" });
  repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "refund", amount: booking.amount,
    paypalId: "refund", captureId: "capture", requestId: "plan:booking", status: "PENDING" });
  return { workspace, booking };
}
describe("PayPal webhook", () => {
  it("rejects missing configuration and invalid signatures without changing state", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "");
    expect((await POST(eventRequest({}))).status).toBe(503);
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "webhook-id");
    const { workspace } = prepared();
    verification(false);
    const event = { id: "bad-event", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "refund" } };
    expect((await POST(eventRequest(event))).status).toBe(401);
    expect(repository.getWebhook(event.id)).toBeUndefined();
    expect(repository.requireWorkspace(workspace.id).state.bookings[0].status).toBe("refund_pending");
  });
  it("verifies the exact event, completes refunds, stores raw events and ignores duplicates", async () => {
    const { workspace, booking } = prepared();
    const fetch = verification(true);
    const event = { id: "refund-event", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: {
      id: "refund", amount: { currency_code: "USD", value: booking.amount }, supplementary_data: { related_ids: { capture_id: "capture" } },
    } };
    const response = await POST(eventRequest(event));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, matched: true });
    expect(repository.requireWorkspace(workspace.id).state.bookings[0].status).toBe("refunded");
    expect(repository.ledgerSummary(workspace.id).refunded).toBe(booking.amount);
    expect(repository.getWebhook(event.id)).toBe(JSON.stringify(event));
    const verificationInit = (fetch.mock.calls[1] as unknown[])[1] as RequestInit;
    expect(JSON.parse(verificationInit.body as string)).toMatchObject({ webhook_id: "webhook-id", webhook_event: event });
    const count = repository.listLedger(workspace.id).length;
    expect(await (await POST(eventRequest(event))).json()).toMatchObject({ duplicate: true });
    expect(repository.listLedger(workspace.id)).toHaveLength(count);
  });
  it("finds a refund by its capture link when the webhook beats the refund HTTP response", async () => {
    const { workspace, booking } = prepared();
    const pending = repository.latestMoneyEvents(workspace.id).find((item) => item.kind === "refund")!;
    repository.appendLedger({ ...pending, paypalId: "", status: "REQUESTED" });
    verification(true);
    const event = { id: "early-event", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: {
      id: "early-refund", invoice_id: pending.requestId, amount: { currency_code: "USD", value: booking.amount }, links: [{ rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/capture" }],
    } };
    expect((await POST(eventRequest(event))).status).toBe(200);
    expect(repository.latestMoneyEvents(workspace.id).find((item) => item.kind === "refund")).toMatchObject({ requestId: "plan:booking", paypalId: "early-refund", status: "COMPLETED" });
    expect(repository.requireWorkspace(workspace.id).state.bookings[0].status).toBe("refunded");
  });
  it.each(["REQUESTED", "PENDING"])("keeps a %s full refund unresolved when a different partial refund completes", (status) => {
    const { workspace, booking } = prepared();
    const original = repository.latestMoneyEvents(workspace.id).find((item) => item.kind === "refund")!;
    repository.appendLedger({ ...original, status, paypalId: status === "REQUESTED" ? "" : "refund" });
    const event = { id: `external-${status}`, event_type: "PAYMENT.CAPTURE.REFUNDED", resource: {
      id: "external-partial", invoice_id: "merchant-operation", amount: { currency_code: "USD", value: "4.00" }, capture_id: "capture",
    } };
    expect(processWebhook(JSON.stringify(event), repository).matched).toBe(true);
    const latest = repository.latestMoneyEvents(workspace.id).filter((item) => item.kind === "refund");
    expect(latest.find((item) => item.requestId === original.requestId)).toMatchObject({ status, amount: booking.amount, paypalId: status === "REQUESTED" ? "" : "refund" });
    expect(latest.find((item) => item.paypalId === "external-partial")).toMatchObject({ requestId: "webhook:external-partial", amount: "4.00", status: "COMPLETED" });
    expect(repository.requireWorkspace(workspace.id).state.bookings[0].status).toBe("refund_pending");
    expect(processWebhook(JSON.stringify({ ...event, id: "redelivery" }), repository).matched).toBe(true);
    expect(repository.ledgerSummary(workspace.id).refunded).toBe("4.00");
  });
  it.each(["missing invoice", "different known ID", "wrong amount"])("does not infer refund identity from a capture alone: %s", (variant) => {
    const { workspace, booking } = prepared();
    const original = repository.latestMoneyEvents(workspace.id).find((item) => item.kind === "refund")!;
    if (variant !== "different known ID") repository.appendLedger({ ...original, paypalId: "", status: "REQUESTED" });
    processWebhook(JSON.stringify({ id: variant, event_type: "PAYMENT.CAPTURE.REFUNDED", resource: {
      id: "another-refund", invoice_id: variant === "missing invoice" ? undefined : original.requestId,
      amount: { currency_code: "USD", value: variant === "wrong amount" ? "4.00" : booking.amount }, capture_id: "capture",
    } }), repository);
    expect(repository.latestMoneyEvents(workspace.id).find((item) => item.requestId === original.requestId)?.status).toBe(variant === "different known ID" ? "PENDING" : "REQUESTED");
  });
  it("records capture reversals and does not undo them on late completion", async () => {
    const { workspace } = prepared();
    verification(true);
    expect((await POST(eventRequest({ id: "reverse", event_type: "PAYMENT.CAPTURE.REVERSED", resource: { id: "capture" } }))).status).toBe(200);
    expect(repository.requireWorkspace(workspace.id).state.bookings[0].status).toBe("cancelled");
    expect((await POST(eventRequest({ id: "late", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "capture" } }))).status).toBe(200);
    expect(repository.latestMoneyEvents(workspace.id).find((item) => item.kind === "capture")?.status).toBe("REVERSED");
    expect(repository.requireWorkspace(workspace.id).state.bookings[0].status).toBe("cancelled");
  });
});
