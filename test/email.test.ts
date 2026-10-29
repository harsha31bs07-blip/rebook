import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emailConfigured, emailEvents, mapEmailEvents, sendEmail } from "../lib/notify/email";
import { creditEmail, deliverableAddress, escapeHtml, outboxEmail } from "../lib/choices/email-content";
import type { CheckoutReservation } from "../lib/store";

const input = { to: "customer@studio.org", name: "Customer", subject: "New class", text: "Message", html: "<p>Message</p>", tags: ["rebook"] };
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("BREVO_API_KEY", "test-key"); vi.stubEnv("BREVO_SENDER_EMAIL", "sender@studio.org");
  fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it("requires both server credentials and sends a single bounded transactional request", async () => {
  expect(emailConfigured()).toBe(true);
  fetchMock.mockResolvedValue(Response.json({ messageId: "<message>" }, { status: 201 }));
  expect(await sendEmail({ ...input, senderName: "Studio via Rebook" })).toEqual({ kind: "accepted", messageId: "<message>" });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://api.brevo.com/v3/smtp/email"); expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(init.body)).toEqual({ sender: { name: "Studio via Rebook", email: "sender@studio.org" }, to: [{ email: input.to, name: input.name }], subject: input.subject, textContent: input.text, htmlContent: input.html, tags: ["rebook"] });
  vi.stubEnv("BREVO_API_KEY", " "); expect(emailConfigured()).toBe(false);
  expect((await sendEmail(input)).kind).toBe("rejected"); expect(fetchMock).toHaveBeenCalledOnce();
});
it.each([400, 401, 402, 429])("treats %s as definitive rejection without echoing provider data", async (status) => {
  fetchMock.mockResolvedValue(Response.json({ message: "private response" }, { status }));
  expect(await sendEmail(input)).toEqual({ kind: "rejected", reason: `Email provider rejected the request (${status}).` });
});
it.each([500, 503, 408, 200])("keeps %s unknown", async (status) => {
  fetchMock.mockResolvedValue(Response.json({}, { status })); expect(await sendEmail(input)).toEqual({ kind: "unknown" });
});
it("does not retry a network failure or malformed accepted response", async () => {
  fetchMock.mockRejectedValueOnce(new Error("network")); expect(await sendEmail(input)).toEqual({ kind: "unknown" });
  fetchMock.mockResolvedValueOnce(Response.json({}, { status: 201 })); expect(await sendEmail(input)).toEqual({ kind: "unknown" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("aborts at ten seconds and leaves the result unknown", async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
  });
  fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
  const result = sendEmail(input); await vi.advanceTimersByTimeAsync(10_000);
  expect(timeout).toHaveBeenCalledWith(10_000); expect(await result).toEqual({ kind: "unknown" }); timeout.mockRestore();
});
it("maps events by date, preserves terminal outcomes and safely handles status outages", async () => {
  const event = (name: string, day: number) => ({ event: name, date: `2026-11-0${day}T12:00:00Z` });
  expect(mapEmailEvents([event("deferred", 2), event("requests", 1)])).toBe("deferred");
  expect(mapEmailEvents([event("deferred", 3), event("delivered", 2), event("requests", 1)])).toBe("delivered");
  expect(mapEmailEvents([event("hardBounces", 3), event("delivered", 2)])).toBe("bounced");
  expect(mapEmailEvents([event("invalid", 2)])).toBe("bounced"); expect(mapEmailEvents([event("requests", 1)])).toBe("sent");
  expect(mapEmailEvents([event("unsubscribed", 1)])).toBeUndefined();
  fetchMock.mockResolvedValueOnce(Response.json({ events: [event("delivered", 2)] }));
  expect(await emailEvents("<id+1>")).toBe("delivered");
  const url = new URL(fetchMock.mock.calls[0][0]); expect(url.searchParams.get("messageId")).toBe("<id+1>"); expect(url.searchParams.get("limit")).toBe("20");
  fetchMock.mockRejectedValueOnce(new Error("unavailable")); expect(await emailEvents("id")).toBeUndefined();
});
it("requires a confirmed checkout for the booking and rejects reserved domains", () => {
  const checkout = (email: string, status = "confirmed") => [{ id: "booking", status, customer: { email } }] as CheckoutReservation[];
  expect(deliverableAddress("customer@studio.org", ["booking"], checkout("CUSTOMER@studio.org"))).toBe(true);
  expect(deliverableAddress("customer@studio.org", ["other"], checkout("customer@studio.org"))).toBe(false);
  expect(deliverableAddress("customer@studio.org", ["booking"], checkout("customer@studio.org", "pending"))).toBe(false);
  expect(deliverableAddress("different@studio.org", ["booking"], checkout("customer@studio.org"))).toBe(false);
  for (const domain of ["example.com", "sub.example.com", "test", "studio.test", "invalid", "studio.invalid", "localhost", "sub.localhost"]) {
    expect(deliverableAddress(`member@${domain}`, ["booking"], checkout(`member@${domain}`))).toBe(false);
  }
});
it("escapes studio and customer content while keeping absolute private links and the demo footer", () => {
  const row = { customerId: "id", customerName: "<Customer>", planId: "plan", changes: [{ bookingId: "booking", subject: "Class & news", body: '<script>alert("x")</script> & hello', path: "/c/private", kind: "choice" as const }] };
  const content = outboxEmail(row, '<Studio "A">', "https://studio.org");
  expect(content.subject).toBe("Class & news"); expect(content.text).toContain("https://studio.org/c/private");
  expect(content.text).toContain("Sent from the Rebook demo (PayPal sandbox; no real money moves).");
  expect(content.html).not.toContain("<script>"); expect(content.html).toContain("&lt;script&gt;"); expect(content.html).toContain("&lt;Studio &quot;A&quot;&gt;");
  expect(content.html).toContain('<a href="https://studio.org/c/private">https://studio.org/c/private</a>');
  expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
});

it("renders the credit email as a clean card with one Redeem button, escaping every studio-supplied value", () => {
  const url = "https://studio.org/b/public#credit=abc";
  const email = creditEmail({ studio: "Flow & <Co>", customerName: "Maya \"M\" Chen", amount: "22.00", url, className: "Yoga <b>Flow</b>",
    classStart: "2026-11-02T12:00:00Z", timezone: "America/New_York" });
  expect(email.subject).toBe("Your $22.00 studio credit at Flow & <Co>");
  expect(email.html).toContain(`<a href="${url}"`); expect(email.html.match(/<a /g)).toHaveLength(1); expect(email.html).toContain(">Redeem your credit</a>");
  expect(email.html).toContain("Flow &amp; &lt;Co&gt;"); expect(email.html).toContain("Yoga &lt;b&gt;Flow&lt;/b&gt;"); expect(email.html).not.toContain("<b>Flow");
  expect(email.html).toContain("Mon, Nov 2, 7:00 AM"); expect(email.html).toContain("Hi Maya,");
  expect(email.text).toContain(`Redeem your credit: ${url}`); expect(email.text).toContain("doesn't expire");
});
