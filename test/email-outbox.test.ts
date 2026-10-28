import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Limits, limits } from "../lib/api/limits";
import { publicOrigin } from "../lib/api/same-origin";
import { refreshEmailStatus, sendAllCustomerEmails, sendCustomerEmail } from "../lib/choices/email";
import { createCustomerLinks, ownerCustomerChoices } from "../lib/choices/service";
import { summarizeOutbox } from "../lib/choices/outbox";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { applyPlan } from "../lib/solver/validate";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import { POST } from "../app/api/workspaces/[id]/outbox/email/route";
import { POST as allPOST } from "../app/api/workspaces/[id]/outbox/email/all/route";
import { POST as statusPOST } from "../app/api/workspaces/[id]/outbox/email/status/route";

let directory: string, repository: Repository, fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "rebook-email-")); vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("BREVO_API_KEY", "test-key"); vi.stubEnv("BREVO_SENDER_EMAIL", "sender@studio.org");
  repository = getRepository(); limits.reset(); fetchMock = vi.fn().mockResolvedValue(Response.json({ messageId: "message-1" }, { status: 201 })); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function fixture() {
  const before = seedStudio(), { id } = repository.createWorkspace(before);
  const plan = { ...repository.createPlan(id, replan(before, demoDisruption, { now: new Date().toISOString() })), status: "executed" as const };
  const after = applyPlan(before, plan); repository.saveState(id, after); repository.savePlan(plan); createCustomerLinks(plan, before, after, repository);
  const rows = () => ownerCustomerChoices(id, repository).outbox;
  const row = rows().find((item) => item.changes.every((change) => change.kind === "choice"))!;
  const booking = after.bookings.find((item) => item.id === row.changes[0].bookingId)!;
  const customer = after.customers.find((item) => item.id === row.customerId)!; customer.email = "customer@studio.org";
  repository.saveState(id, after);
  repository.saveCheckout({ id: booking.id, workspaceId: id, requestId: "checkout", sessionId: booking.sessionId, customer: { name: customer.name, email: customer.email },
    amount: booking.amount, currency: "USD", session: after.sessions.find((session) => session.id === booking.sessionId)!, status: "confirmed", expiresAt: Date.now() });
  const input = { planId: plan.id, customerId: row.customerId };
  const send = (extra = {}) => sendCustomerEmail(id, { ...input, ...extra }, "https://studio.org", "client", repository);
  return { id, plan, row, rows, input, send };
}
it("leaves every seeded hero row a demo address", () => {
  const { rows, row } = fixture();
  expect(rows().filter((item) => item.emailDeliverable).map((item) => item.customerId)).toEqual([row.customerId]);
  const { id } = repository.createWorkspace(seedStudio()); const before = repository.requireWorkspace(id).state;
  const plan = { ...repository.createPlan(id, replan(before, demoDisruption, { now: new Date().toISOString() })), status: "executed" as const };
  repository.savePlan(plan); createCustomerLinks(plan, before, applyPlan(before, plan), repository);
  expect(ownerCustomerChoices(id, repository).outbox.every((item) => item.emailDeliverable === false)).toBe(true);
});
it("queues durably before fetch, refuses concurrent duplicate sends and records manual contact on acceptance", async () => {
  const { id, input, send, rows } = fixture(); let resolve!: (value: Response) => void;
  fetchMock.mockImplementationOnce(() => {
    expect(repository.listDeliveries(id)[0].status).toBe("queued");
    return new Promise<Response>((done) => { resolve = done; });
  });
  const first = send(); await expect(send()).rejects.toMatchObject({ status: 409 });
  resolve(Response.json({ messageId: "message-1" }, { status: 201 })); await first;
  expect(repository.listDeliveries(id)[0]).toMatchObject({ ...input, status: "sent", messageId: "message-1" });
  expect(summarizeOutbox(rows()).sent).toBe(1); await expect(send()).rejects.toMatchObject({ status: 409 }); expect(fetchMock).toHaveBeenCalledOnce();
  closeRepository(); repository = getRepository(); expect(repository.listDeliveries(id)[0].status).toBe("sent");
});
it("never automatically retries unknown outcomes, but allows an explicit resend", async () => {
  const { id, plan, send, rows } = fixture(); fetchMock.mockRejectedValueOnce(new Error("lost response"));
  await send(); expect(repository.listDeliveries(id)[0].status).toBe("unknown"); expect(summarizeOutbox(rows()).sent).toBe(0);
  await expect(send()).rejects.toMatchObject({ status: 409 }); await sendAllCustomerEmails(id, plan.id, "https://studio.org", "client", repository);
  expect(fetchMock).toHaveBeenCalledOnce(); await send({ resend: true }); expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("turns abandoned queued attempts into unknown after restart and requires explicit resend", async () => {
  const { id, input, send } = fixture(); repository.queueDelivery({ workspaceId: id, ...input, kind: "message" });
  closeRepository(); vi.setSystemTime(new Date(Date.now() + 31_000)); repository = getRepository();
  expect(repository.listDeliveries(id)[0].status).toBe("unknown"); await expect(send()).rejects.toMatchObject({ status: 409 }); expect(fetchMock).not.toHaveBeenCalled();
  await send({ resend: true }); expect(fetchMock).toHaveBeenCalledOnce();
});
it("makes a 400 failure retryable without marking contact, and stores reminders separately", async () => {
  const { id, send, rows } = fixture(); fetchMock.mockResolvedValueOnce(Response.json({}, { status: 400 }));
  await send(); expect(repository.listDeliveries(id)[0].status).toBe("failed"); expect(summarizeOutbox(rows()).sent).toBe(0);
  await send(); expect(summarizeOutbox(rows()).sent).toBe(1);
  await send({ reminder: true }); expect(repository.listDeliveries(id).map((row) => row.kind)).toEqual(["message", "reminder"]);
  await expect(send({ reminder: true })).rejects.toMatchObject({ status: 409 });
});
it("checks status once per workspace minute, preserves terminal outcomes and stops after three days", async () => {
  const { id, send } = fixture(); await send();
  fetchMock.mockImplementation(async () => Response.json({ events: [{ event: "deferred", date: new Date().toISOString() }] }));
  await refreshEmailStatus(id, repository); expect(repository.listDeliveries(id)[0].status).toBe("deferred");
  await refreshEmailStatus(id, repository); expect(fetchMock).toHaveBeenCalledTimes(2);
  vi.setSystemTime(new Date(Date.now() + 60_000)); fetchMock.mockResolvedValueOnce(Response.json({ events: [{ event: "delivered", date: new Date().toISOString() }] }));
  await refreshEmailStatus(id, repository); expect(repository.listDeliveries(id)[0].status).toBe("delivered");
  vi.setSystemTime(new Date(Date.now() + 60_000)); await refreshEmailStatus(id, repository); expect(fetchMock).toHaveBeenCalledTimes(3);
  const delivery = repository.listDeliveries(id)[0]; repository.saveDelivery({ ...delivery, status: "sent", createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() });
  await refreshEmailStatus(id, repository); expect(fetchMock).toHaveBeenCalledTimes(3);
});
it("allows bounced resends only explicitly and keeps bulk sends to eligible unsent rows", async () => {
  const { id, plan, send } = fixture(); await sendAllCustomerEmails(id, plan.id, "https://studio.org", "client", repository); expect(fetchMock).toHaveBeenCalledOnce();
  fetchMock.mockResolvedValueOnce(Response.json({ events: [{ event: "hardBounces", date: new Date().toISOString() }] }));
  await refreshEmailStatus(id, repository); expect(repository.listDeliveries(id)[0].status).toBe("bounced");
  await expect(send()).rejects.toMatchObject({ status: 409 }); await send({ resend: true }); expect(fetchMock).toHaveBeenCalledTimes(3);
});
it("rejects foreign origins, invalid bodies, demo addresses, other workspaces and unconfigured delivery", async () => {
  const { id, input, rows } = fixture();
  const post = (handler = POST, body: unknown = input, origin = "https://studio.org", workspace = id) => handler(new Request(`https://studio.org/api/workspaces/${workspace}/outbox/email`, {
    method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: workspace }) });
  for (const handler of [POST, allPOST, statusPOST]) expect((await post(handler, { planId: input.planId }, "https://other.org")).status).toBe(403);
  expect((await post(POST, { ...input, to: "override@studio.org" })).status).toBe(400);
  expect((await post(POST, { ...input, customerId: rows().find((row) => !row.emailDeliverable)!.customerId })).status).toBe(422);
  expect((await post(POST, input, "https://studio.org", repository.createWorkspace(seedStudio()).id)).status).toBe(404);
  vi.stubEnv("BREVO_API_KEY", "");
  for (const handler of [POST, allPOST]) { const response = await post(handler, handler === POST ? input : { planId: input.planId }); expect(response.status).toBe(503); expect(await response.text()).toContain("not configured"); }
  expect(fetchMock).not.toHaveBeenCalled();
});
it("sends and refreshes through the owner API using the configured public origin", async () => {
  const { id, input, row } = fixture(); vi.stubEnv("PUBLIC_ORIGIN", "https://public.studio.org");
  const post = (handler: typeof POST, body: unknown) => handler(new Request(`http://internal:3000/api/workspaces/${id}/outbox/email`, {
    method: "POST", headers: { origin: "https://public.studio.org" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
  const sent = await post(POST, input); expect(sent.status).toBe(200); expect(sent.headers.get("Cache-Control")).toBe("no-store");
  expect((await sent.json()).outbox.find((item: { customerId: string }) => item.customerId === row.customerId).delivery.status).toBe("sent");
  const content = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(content.textContent).toContain(`https://public.studio.org${row.changes[0].path}`); expect(content.sender.name).toContain("via Rebook");
  expect((await post(allPOST, { planId: input.planId })).status).toBe(200); expect(fetchMock).toHaveBeenCalledOnce();
  fetchMock.mockResolvedValueOnce(Response.json({ events: [{ event: "delivered", date: new Date().toISOString() }] }));
  const refreshed = await post(statusPOST, { planId: input.planId }); expect(refreshed.status).toBe(200);
  expect((await refreshed.json()).outbox.find((item: { customerId: string }) => item.customerId === row.customerId).delivery.status).toBe("delivered");
});
it("enforces atomic client, workspace and global email limits with hourly/daily expiry", () => {
  const limiter = new Limits();
  for (let count = 0; count < 20; count++) limiter.email("client", `studio-${count}`);
  expect(() => limiter.email("client", "new")).toThrow(); vi.setSystemTime(new Date(Date.now() + 3_600_000)); expect(() => limiter.email("client", "new")).not.toThrow();
  limiter.reset(); for (let count = 0; count < 30; count++) limiter.email(`client-${count}`, "studio");
  expect(() => limiter.email("extra", "studio")).toThrow();
  limiter.reset(); for (let count = 0; count < 250; count++) limiter.email(`client-${count}`, `studio-${count}`);
  expect(() => limiter.email("extra", "extra")).toThrow(); vi.setSystemTime(new Date(Date.now() + 86_400_000)); expect(() => limiter.email("extra", "extra")).not.toThrow();
});
it("returns 429 before sending or reserving when the client quota is exhausted", async () => {
  const { id, input } = fixture(); for (let count = 0; count < 20; count++) limits.email("unknown", `other-${count}`);
  const response = await POST(new Request(`https://studio.org/api/workspaces/${id}/outbox/email`, { method: "POST", body: JSON.stringify(input) }), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(429); expect(response.headers.get("Retry-After")).toBeTruthy(); expect(repository.listDeliveries(id)).toEqual([]); expect(fetchMock).not.toHaveBeenCalled();
});
it("builds public links from configured or forwarded origin", () => {
  const request = new Request("http://internal:3000", { headers: { "x-forwarded-host": "studio.org", "x-forwarded-proto": "https" } });
  expect(publicOrigin(request)).toBe("https://studio.org"); vi.stubEnv("PUBLIC_ORIGIN", "https://public.org/path"); expect(publicOrigin(request)).toBe("https://public.org");
});
