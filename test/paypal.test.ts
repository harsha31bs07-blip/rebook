import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureOrder, createCardCapture, createCheckoutOrder, getCapture, PayPalError, refundCapture, verifyWebhookSignature } from "../lib/paypal/client";

const reply = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers });
beforeEach(() => {
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  vi.stubEnv("PAYPAL_CLIENT_ID", randomUUID());
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "mock-secret");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("PayPal client", () => {
  it("caches a token, shares concurrent refreshes, and refreshes 60 seconds before expiry", async () => {
    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    const fetch = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/token")
      ? reply({ access_token: "token", expires_in: 120 }) : reply({ id: "capture", status: "COMPLETED" }));
    vi.stubGlobal("fetch", fetch);
    await Promise.all([getCapture("one"), getCapture("two")]);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(1);
    time += 59_000;
    await getCapture("three");
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(1);
    time += 2000;
    await getCapture("four");
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(2);
  });

  it("retries 429 and 5xx with the same PayPal-Request-Id and body", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(reply({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(reply({}, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(reply({}, 503))
      .mockResolvedValueOnce(reply({ id: "refund", status: "COMPLETED" }, 201));
    vi.stubGlobal("fetch", fetch);
    const result = refundCapture("capture", "18.00", "Class cancelled", "same-request");
    await vi.runAllTimersAsync();
    expect((await result).id).toBe("refund");
    const calls = fetch.mock.calls.slice(1).map(([, init]) => init as RequestInit);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((init) => (init.headers as Record<string, string>)["PayPal-Request-Id"]))).toEqual(new Set(["same-request"]));
    expect(new Set(calls.map((init) => init.body)).size).toBe(1);
  });

  it("exposes the upstream name, status and debug id and limits retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn().mockResolvedValueOnce(reply({ access_token: "token", expires_in: 3600 }))
      .mockImplementation(async () => reply({ name: "UNPROCESSABLE_ENTITY", message: "Cannot refund" }, 422, { "paypal-debug-id": "debug-123" }));
    vi.stubGlobal("fetch", fetch);
    await expect(refundCapture("capture", "18.00", "Refund", "request")).rejects.toMatchObject({
      status: 422, name: "UNPROCESSABLE_ENTITY", message: "Cannot refund", debugId: "debug-123",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops after three server error attempts", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn().mockResolvedValueOnce(reply({ access_token: "token", expires_in: 3600 }))
      .mockImplementation(async () => reply({ name: "INTERNAL_SERVER_ERROR" }, 500));
    vi.stubGlobal("fetch", fetch);
    const result = expect(getCapture("capture")).rejects.toBeInstanceOf(PayPalError);
    await vi.runAllTimersAsync();
    await result;
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("creates a sandbox card capture and passes decimal USD amounts", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(reply({ id: "order", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "capture", status: "COMPLETED" }] } }] }, 201, { "paypal-debug-id": "debug" }));
    vi.stubGlobal("fetch", fetch);
    expect(await createCardCapture("18.00", { workspaceId: "workspace", bookingId: "booking" })).toEqual({ orderId: "order", captureId: "capture", status: "COMPLETED", debugId: "debug" });
    const init = fetch.mock.calls[1][1] as RequestInit;
    expect((init.headers as Record<string, string>)["PayPal-Request-Id"]).toBe("workspacebooking");
    expect(JSON.parse(init.body as string)).toMatchObject({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "18.00" } }], payment_source: { card: { expiry: "2030-12" } } });
  });

  it("supports checkout approval and subsequent capture", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(reply({ id: "order", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://example.com/approve" }] }))
      .mockResolvedValueOnce(reply({ id: "order", status: "COMPLETED" }));
    vi.stubGlobal("fetch", fetch);
    expect((await createCheckoutOrder("22.00", { workspaceId: "w", bookingId: "b" }, "https://example.com/return", "https://example.com/cancel")).status).toBe("PAYER_ACTION_REQUIRED");
    expect((await captureOrder("order", "capture-key")).status).toBe("COMPLETED");
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ payment_source: { paypal: { experience_context: { user_action: "PAY_NOW", return_url: "https://example.com/return" } } } });
  });

  it("refuses unknown environments and live demo cards", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("PAYPAL_ENV", "production");
    await expect(getCapture("capture")).rejects.toThrow("sandbox or live");
    vi.stubEnv("PAYPAL_ENV", "live");
    await expect(createCardCapture("18.00", { workspaceId: "w", bookingId: "b" })).rejects.toThrow("sandbox");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not send verification when required signature headers are missing", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await verifyWebhookSignature(new Headers(), "{}", "webhook")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
