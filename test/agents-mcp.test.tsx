import { setSdkTransport } from "./paypalTransport";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { executePlan } from "../lib/executor/executePlan";
import { handleMcp } from "../lib/agents/mcp";
import { limits } from "../lib/api/limits";
import { DELETE, GET, POST } from "../app/api/mcp/[bookingId]/route";
import PayPalReturn from "../components/booking/paypal-return";

type Body = { purchase_units: unknown[]; payment_source?: { paypal?: { experience_context?: Record<string, string> } } };
let directory: string, repository: Repository, workspaceId: string, bookingId: string;
const orders = new Map<string, Body & { id: string; status: string; links?: { rel: string; href: string }[] }>();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "rebook-mcp-")); vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("PAYPAL_CLIENT_ID", randomUUID()); vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret"); vi.stubEnv("PAYPAL_ENV", "sandbox");
  repository = getRepository(); orders.clear(); limits.reset();
  setSdkTransport(async (url, init) => {
    if (url.endsWith("/token")) return Response.json({ access_token: "token", token_type: "Bearer", expires_in: 3600 });
    if (url.endsWith("/refund")) return Response.json({ id: `REFUND-${randomUUID()}`, status: "COMPLETED", amount: JSON.parse(init.body as string).amount }, { status: 201 });
    if (url.endsWith("/v2/checkout/orders")) {
      const id = `ORDER-${orders.size}`, body = JSON.parse(init.body as string) as Body;
      const order = { id, status: body.payment_source ? "PAYER_ACTION_REQUIRED" : "CREATED", ...body,
        links: [{ rel: "self", href: `https://api.sandbox.paypal.com/v2/checkout/orders/${id}` }, { rel: body.payment_source ? "payer-action" : "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] };
      orders.set(id, order); return Response.json(order, { status: 201 });
    }
    return Response.json(orders.get(new URL(url).pathname.split("/").at(-1)!));
  });
  const state = seedStudio(); for (const booking of state.bookings) booking.payment!.simulated = true;
  const workspace = repository.createWorkspace(state); workspaceId = workspace.id; bookingId = workspace.bookingId;
  for (const booking of state.bookings) repository.appendLedger({ workspaceId, bookingId: booking.id, kind: "capture", amount: booking.amount,
    paypalId: booking.payment!.captureId, captureId: booking.payment!.captureId, requestId: `capture:${booking.id}`, status: "SIMULATED" });
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

const context = () => ({ workspaceId, bookingId, origin: "https://rebook.example" });
let nextId = 1;
const rpc = (method: string, params?: unknown) => handleMcp({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }, context(), repository) as Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }>;
async function tool(name: string, args: Record<string, unknown>) {
  const result = (await rpc("tools/call", { name, arguments: args })).result as { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
  return { text: result.content[0].text, data: result.structuredContent as Record<string, unknown> & { classes?: { classId: string; classType: string; seatsLeft: number; status: string }[] }, isError: !!result.isError };
}
const yogaClass = async () => (await tool("list_classes", { classType: "yoga" })).data.classes!.find((item) => item.status === "open")!;

it("speaks MCP: initialize, tools/list, ping, notifications and errors", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "rebook-studio" } });
  expect((init.result as { instructions: string }).instructions).toMatch(/never pay/);
  expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).result).toMatchObject({ protocolVersion: "2025-06-18" });
  const names = ((await rpc("tools/list")).result as { tools: { name: string; inputSchema: { type: string } }[] }).tools.map((item) => item.name);
  expect(names).toEqual(["list_classes", "book_class", "join_waitlist", "get_rebooking_options", "answer_rebooking"]);
  expect((await rpc("ping")).result).toEqual({});
  expect(await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, context(), repository)).toBeUndefined();
  expect((await rpc("resources/list")).error).toMatchObject({ code: -32601 });
  expect(await handleMcp({ id: 1, method: "ping" }, context(), repository)).toMatchObject({ error: { code: -32600 } });
  expect((await rpc("tools/call", { name: "pay_for_me", arguments: {} })).error).toMatchObject({ code: -32602 });
});

it("lists upcoming classes with filters and seats", async () => {
  const all = await tool("list_classes", {});
  expect(all.data.classes!.length).toBeGreaterThan(10);
  const yoga = await tool("list_classes", { classType: "yoga", day: "monday" });
  expect(yoga.data.classes!.every((item) => item.classType === "yoga")).toBe(true);
  expect(yoga.text).toMatch(/classId /);
  expect((await tool("list_classes", { classType: "yoga", query: "zzz" })).text).toMatch(/No upcoming classes/);
  expect((await tool("list_classes", { unexpected: 1 })).isError).toBe(true);
});

it("books by holding a seat and returning a PayPal approval link the person must approve", async () => {
  const yoga = await yogaClass();
  const booked = await tool("book_class", { classId: yoga.classId, name: "Avery Lane", email: "avery@example.com" });
  expect(booked.isError).toBe(false);
  expect(booked.data).toMatchObject({ status: "awaiting_payment_approval", approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-0" });
  expect(booked.text).toMatch(/cannot pay or approve/);
  const body = orders.get("ORDER-0")!;
  expect(body.payment_source?.paypal?.experience_context).toMatchObject({ return_url: `https://rebook.example/b/${bookingId}/paid`, cancel_url: `https://rebook.example/b/${bookingId}`, user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" });
  expect(repository.listCheckout(workspaceId)).toEqual([expect.objectContaining({ status: "pending", sessionId: yoga.classId, customer: { name: "Avery Lane", email: "avery@example.com" } })]);
  const again = await tool("book_class", { classId: yoga.classId, name: "Avery Lane", email: "avery@example.com" });
  expect(again.data.approvalUrl).toBe(booked.data.approvalUrl); expect(orders.size).toBe(1);
  expect((await tool("book_class", { classId: "nope", name: "A", email: "a@example.com" })).text).toMatch(/list_classes/);
  expect((await tool("book_class", { classId: yoga.classId, name: "A", email: "not-an-email" })).isError).toBe(true);
});

it("does not book or charge someone who already holds a seat in the class", async () => {
  const yoga = await yogaClass(), state = repository.requireWorkspace(workspaceId).state;
  const booked = state.bookings.find((booking) => booking.sessionId === yoga.classId && booking.status === "confirmed")!, person = state.customers.find((customer) => customer.id === booked.customerId)!;
  const result = await tool("book_class", { classId: yoga.classId, name: person.name, email: person.email.toUpperCase() });
  expect(result.data).toMatchObject({ status: "already_booked" }); expect(result.text).toMatch(/already booked/); expect(orders.size).toBe(0);
});
it("sends a full class to the waitlist, keeping one place per email", async () => {
  const state = repository.requireWorkspace(workspaceId).state, yoga = await yogaClass();
  state.sessions.find((item) => item.id === yoga.classId)!.capacity = state.bookings.filter((item) => item.sessionId === yoga.classId).length;
  repository.saveState(workspaceId, state);
  expect((await tool("book_class", { classId: yoga.classId, name: "Sam Lee", email: "sam@example.com" })).text).toMatch(/join_waitlist/);
  const joined = await tool("join_waitlist", { classId: yoga.classId, name: "Sam Lee", email: "sam@example.com" });
  expect(joined.data).toMatchObject({ position: 1 });
  expect((await tool("join_waitlist", { classId: yoga.classId, name: "Sam Lee", email: "SAM@example.com" })).data).toMatchObject({ position: 1 });
  const after = repository.requireWorkspace(workspaceId).state, sam = after.customers.find((item) => item.email === "sam@example.com")!;
  expect(after.waitlist!.filter((entry) => entry.customerId === sam.id)).toHaveLength(1);
  const open = (await tool("list_classes", {})).data.classes!.find((item) => item.status === "open" && item.classId !== yoga.classId)!;
  expect((await tool("join_waitlist", { classId: open.classId, name: "Sam Lee", email: "sam@example.com" })).text).toMatch(/book it instead/);
});

it("answers a rebooking link, and refunds only after the person confirmed", async () => {
  const plan = repository.createPlan(workspaceId, replan(repository.requireWorkspace(workspaceId).state, demoDisruption));
  await executePlan(workspaceId, plan.id, repository);
  const links = repository.listCustomerLinks(workspaceId).filter((link) => link.kind === "choice");
  const url = `https://rebook.example/c/${repository.customerToken(links[0])}`;
  const options = await tool("get_rebooking_options", { link: url });
  expect(options.data).toMatchObject({ canChoose: true }); expect(options.text).toMatch(/Options:/);
  const asked = await tool("answer_rebooking", { link: url, option: "refund" });
  expect(asked.data).toMatchObject({ status: "needs_confirmation" }); expect(asked.text).toMatch(/confirm/);
  expect(repository.customerLinkByToken(repository.customerToken(links[0]))!.reply).toBeUndefined();
  const refunded = await tool("answer_rebooking", { link: url, option: "refund", confirm: true });
  expect(refunded.data).toMatchObject({ status: "answered", answered: "refund" });
  expect((await tool("answer_rebooking", { link: repository.customerToken(links[1]), option: "keep" })).data).toMatchObject({ answered: "keep" });
  expect((await tool("get_rebooking_options", { link: "short" })).isError).toBe(true);
});

it("guards the HTTP endpoint", async () => {
  const request = (body: string, headers: Record<string, string> = {}) => new Request(`http://localhost/api/mcp/${bookingId}`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  const params = (id = bookingId) => ({ params: Promise.resolve({ bookingId: id }) });
  const ok = await POST(request(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })), params());
  expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  expect((await POST(request(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })), params())).status).toBe(202);
  expect((await POST(request("{"), params())).status).toBe(400);
  expect((await POST(request("{}", { origin: "https://evil.example" }), params())).status).toBe(403);
  expect((await POST(request("{}"), params("x".repeat(32)))).status).toBe(404);
  expect((await GET()).status).toBe(405); expect((await DELETE()).status).toBe(405);
});

it("renders the PayPal return page states", () => {
  expect(renderToStaticMarkup(<PayPalReturn bookingId="b" timezone="America/New_York" />)).toContain("missing its order");
  expect(renderToStaticMarkup(<PayPalReturn bookingId="b" orderId="ORDER-1" timezone="America/New_York" />)).toContain("Checking with PayPal");
});
