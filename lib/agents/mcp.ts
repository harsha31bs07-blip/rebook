import { createHash } from "node:crypto";
import { z } from "zod";
import { bookingCatalog, createOrder } from "../checkout/service";
import { ChoiceInputSchema, ChoiceTokenSchema, customerChoice, submitChoice } from "../choices/service";
import { approvalLink, getOrder, PayPalError } from "../paypal/client";
import { getRepository, StoreError, type Repository } from "../store";
import { limits } from "../api/limits";
import { joinWaitlist } from "../waitlist/service";
import { localClass } from "../webmcp/tools";

/**
 * A remote MCP server per studio (the public booking capability), so a customer's own AI agent can find, book or
 * rebook a class. Money rule: the agent never pays. Booking returns a PayPal link the person approves on PayPal;
 * a refund needs the customer's explicit confirmation passed back as confirm: true.
 */
export const MCP_VERSIONS = ["2025-06-18", "2025-03-26"];
const INSTRUCTIONS = "Rebook studio tools. You can list classes, book one for the person you help, join a waitlist, or answer their private rebooking link. You never pay: book_class returns a PayPal link the person opens to approve the payment. A refund needs the person's explicit confirmation of the amount first.";
type Context = { workspaceId: string; bookingId: string; origin: string; ip?: string; repository: Repository };
type Result = { text: string; data: unknown };
const str = (maxLength: number, description: string) => ({ type: "string", maxLength, description });
const Person = { name: z.string().trim().min(1).max(100), email: z.string().trim().pipe(z.email().max(254)) };
const LinkSchema = z.string().trim().max(300).transform((value) => value.match(/([A-Za-z0-9_-]{43})(?:[?#].*)?$/)?.[1] ?? value).pipe(ChoiceTokenSchema);

const tools = [
  { name: "list_classes", title: "List classes",
    description: "Upcoming classes at this studio with studio-local day and time, instructor, room, price and seats left. Filter by day (YYYY-MM-DD or weekday name), classType (yoga, pilates, spin, dance, hiit, barre) or a words query.",
    inputSchema: { type: "object", properties: { day: str(20, "YYYY-MM-DD or a weekday name"), classType: str(20, "yoga, pilates, spin, dance, hiit or barre"), query: str(80, "Words in the class title or instructor") }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "book_class", title: "Book a class (person approves payment)",
    description: "Hold a seat for 10 minutes and create a PayPal order for the person you help. Returns approvalUrl: give it to the person; they approve the payment on PayPal and return to the studio. You cannot pay or approve for them.",
    inputSchema: { type: "object", properties: { classId: str(100, "classId from list_classes"), name: str(100, "The person's name"), email: { ...str(254, "The person's email"), format: "email" } }, required: ["classId", "name", "email"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: "join_waitlist", title: "Join a waitlist",
    description: "Join the waitlist of a full class. When a spot opens the studio offers it in order and the person gets a private link.",
    inputSchema: { type: "object", properties: { classId: str(100, "classId of a full class"), name: str(100, "The person's name"), email: { ...str(254, "The person's email"), format: "email" } }, required: ["classId", "name", "email"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "get_rebooking_options", title: "Read a rebooking link",
    description: "The studio changed one of the person's classes and sent them a private link (/c/...). Read what changed and their options: keep, move to another class, studio credit or a refund.",
    inputSchema: { type: "object", properties: { link: str(300, "The person's private link or its token") }, required: ["link"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "answer_rebooking", title: "Answer a rebooking link",
    description: "Answer the person's private rebooking link: keep, move (with classId from get_rebooking_options), credit, or refund. A refund needs confirm: true, set only after the person explicitly confirmed the amount.",
    inputSchema: { type: "object", properties: { link: str(300, "The person's private link or its token"), option: { type: "string", enum: ["keep", "move", "credit", "refund"] },
      classId: str(100, "For move: a classId from get_rebooking_options"), confirm: { type: "boolean", description: "Refund only: the person confirmed the refund amount" } }, required: ["link", "option"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } },
] as const;

const money = (value: string) => `$${value}`;
function upcoming(context: Context) {
  const { studio, sessions } = bookingCatalog(context.workspaceId, context.repository);
  return { studio, classes: sessions.filter((session) => Date.parse(session.start) > Date.now()).map((session) => ({ classId: session.id, title: session.title, classType: session.classType,
    ...localClass(session.start, session.end, studio.timezone), start: session.start, instructor: session.instructor, room: session.room, price: session.price,
    seatsLeft: session.seatsLeft, status: session.bookingPaused ? "paused" : session.seatsLeft > 0 ? "open" : "full - join_waitlist" })) };
}
function findClass(context: Context, classId: string) {
  const found = upcoming(context).classes.find((item) => item.classId === classId);
  if (!found) throw new StoreError(404, "Unknown or past class. Call list_classes again.");
  return found;
}

async function call(name: string, args: Record<string, unknown>, context: Context): Promise<Result> {
  if (name === "list_classes") {
    const input = z.strictObject({ day: z.string().max(20).optional(), classType: z.string().max(20).optional(), query: z.string().max(80).optional() }).parse(args);
    const day = input.day?.trim().toLowerCase(), type = input.classType?.trim().toLowerCase(), words = input.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const { studio, classes } = upcoming(context);
    const matches = classes.filter((item) => (!day || item.day === day || item.weekday.toLowerCase() === day) && (!type || item.classType === type)
      && words.every((word) => `${item.title} ${item.instructor}`.toLowerCase().includes(word)));
    return { data: { studio: studio.name, timezone: studio.timezone, currency: studio.currency, classes: matches },
      text: matches.length ? `${matches.length} classes at ${studio.name} (${studio.timezone}):\n${matches.slice(0, 30).map((item) => `- ${item.title}, ${item.weekday} ${item.day} ${item.startTime}-${item.endTime} with ${item.instructor}, ${money(item.price)}, ${item.status === "open" ? `${item.seatsLeft} seats left` : item.status} (classId ${item.classId})`).join("\n")}` : `No upcoming classes match at ${studio.name}.` };
  }
  if (name === "book_class") {
    const input = z.strictObject({ classId: z.string().min(1).max(100), ...Person }).parse(args);
    const found = findClass(context, input.classId);
    if (found.status === "paused") throw new StoreError(409, "This class is paused while the studio confirms a change. Try another class.");
    const { state } = context.repository.requireReadyWorkspace(context.workspaceId), email = input.email.toLowerCase();
    const person = state.customers.find((customer) => customer.email.toLowerCase() === email);
    if (person && state.bookings.some((booking) => booking.sessionId === input.classId && booking.customerId === person.id && ["confirmed", "moved"].includes(booking.status))) {
      return { data: { status: "already_booked", class: found }, text: `${input.name} is already booked in ${found.title} (${found.weekday} ${found.startTime}). Nothing more to pay.` };
    }
    if (found.seatsLeft <= 0) throw new StoreError(409, "This class is full. Use join_waitlist to join its waitlist.");
    // Agent bookings hold seats like the booking page, so they share its checkout limits.
    limits.take([{ key: `checkout-client:${context.ip ?? "agent"}`, max: 60, ms: 60_000 }, { key: `checkout-workspace:${context.workspaceId}`, max: 120, ms: 60_000 }, { key: "checkout-global", max: 600, ms: 60_000 }]);
    // One hold per person and class per 10-minute window: a retried call returns the same PayPal link.
    const window = Math.floor(Date.now() / 600_000);
    const requestId = `agent-${createHash("sha256").update(`${input.classId}|${input.email.toLowerCase()}|${window}`).digest("hex").slice(0, 32)}`;
    const studio = state.studio;
    const order = await createOrder(context.workspaceId, { sessionId: input.classId, customer: { name: input.name, email: input.email } }, requestId, context.repository,
      { returnUrl: `${context.origin}/b/${context.bookingId}/paid`, cancelUrl: `${context.origin}/b/${context.bookingId}`, brandName: studio.name });
    const approvalUrl = order.approvalUrl ?? approvalLink(await getOrder(order.orderId));
    if (!approvalUrl) throw new StoreError(502, "PayPal did not return an approval link. Try again.");
    const hold = context.repository.checkoutByOrder(context.workspaceId, order.orderId);
    const until = hold ? new Intl.DateTimeFormat("en-US", { timeZone: studio.timezone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(hold.expiresAt)) : "10 minutes from now";
    return { data: { status: "awaiting_payment_approval", approvalUrl, amount: found.price, currency: studio.currency, holdExpiresAt: hold ? new Date(hold.expiresAt).toISOString() : undefined, class: found },
      text: `Seat held for ${input.name} in ${found.title} (${found.weekday} ${found.startTime}) until ${until}. Give them this PayPal link to approve ${money(found.price)}; they return to the studio when it is paid:\n${approvalUrl}\nYou cannot pay or approve for them.` };
  }
  if (name === "join_waitlist") {
    const input = z.strictObject({ classId: z.string().min(1).max(100), ...Person }).parse(args);
    const joined = await joinWaitlist(context.workspaceId, input.classId, input, context.repository);
    return { data: joined, text: `${input.name} is number ${joined.position} on the waitlist for ${joined.title}. If a spot opens, the studio offers it in order with a private link.` };
  }
  const token = LinkSchema.parse(args.link);
  if (name === "get_rebooking_options") {
    const view = await customerChoice(token, context.repository);
    const when = (start: string) => new Intl.DateTimeFormat("en-US", { timeZone: view.studio.timezone, weekday: "long", hour: "numeric", minute: "2-digit" }).format(new Date(start));
    const moves = view.alternatives.map((item) => ({ classId: item.id, title: item.title, start: item.start, when: when(item.start), instructor: item.instructor, difference: item.difference }));
    const refund = view.entitlement ? `the visit goes back to their ${view.entitlement.name}` : `${money(view.creditRefundable ?? view.refundable)} back to ${view.paidWith === "credit" ? "studio credit" : "their original payment"}`;
    const options = view.canChoose ? { keep: !!view.after, move: moves, credit: !view.entitlement, refund } : undefined;
    return { data: { studio: view.studio.name, message: view.message, before: { title: view.before.title, when: when(view.before.start) }, now: view.after ? { title: view.after.title, when: when(view.after.start), instructor: view.after.instructor } : undefined,
      canChoose: view.canChoose, answered: view.reply?.action, options },
      text: `${view.studio.name}: ${view.message}\n${view.canChoose ? `Options: ${view.after ? `keep ${view.after.title} on ${when(view.after.start)}; ` : ""}move to ${moves.length ? moves.slice(0, 8).map((item) => `${item.title} ${item.when} (classId ${item.classId})`).join(", ") : "no other class with room"}; ${view.entitlement ? "" : "studio credit; "}refund: ${refund}.` : view.reply ? `Already answered: ${view.reply.action}.` : "This link can no longer be answered."}` };
  }
  if (name === "answer_rebooking") {
    const input = z.strictObject({ link: z.unknown(), option: z.enum(["keep", "move", "credit", "refund"]), classId: z.string().max(100).optional(), confirm: z.boolean().optional() }).parse(args);
    if (input.option === "refund" && input.confirm !== true) {
      const view = await customerChoice(token, context.repository);
      const amount = view.entitlement ? `the visit back to their ${view.entitlement.name}` : money(view.creditRefundable ?? view.refundable);
      return { data: { status: "needs_confirmation", option: "refund", amount: view.entitlement ? undefined : view.creditRefundable ?? view.refundable },
        text: `Before refunding, ask the person to confirm: ${amount}${view.entitlement ? "" : ` back to ${view.paidWith === "credit" ? "studio credit" : "their original payment"}`}. Then call answer_rebooking again with confirm: true.` };
    }
    if (input.option === "move" && !input.classId) throw new StoreError(400, "Moving needs a classId from get_rebooking_options.");
    const choice = ChoiceInputSchema.parse(input.option === "move" ? { action: "move", sessionId: input.classId } : { action: input.option });
    const view = await submitChoice(token, choice, context.repository);
    const receipt = view.receipt ? ` Refund status: ${view.receipt.status.toLowerCase()}${view.receipt.paypalId ? ` (PayPal ${view.receipt.paypalId})` : ""}.` : "";
    return { data: { status: "answered", answered: view.reply?.action, receipt: view.receipt },
      text: `Done: ${input.option === "keep" ? "they keep their class" : input.option === "move" ? "they moved to the new class" : input.option === "credit" ? "the class is now studio credit" : "the refund was requested"}.${receipt}` };
  }
  throw new RpcError(-32602, `Unknown tool: ${name}`);
}

class RpcError extends Error { constructor(public code: number, message: string) { super(message); } }
type Request = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
const reply = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const failure = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** One JSON-RPC message in, one response out (undefined for notifications). */
export async function handleMcp(message: unknown, context: Omit<Context, "repository">, repository = getRepository()): Promise<object | undefined> {
  const request = (message && typeof message === "object" && !Array.isArray(message) ? message : {}) as Request;
  const id = request.id;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return failure(id, -32600, "Invalid JSON-RPC request.");
  const notification = !("id" in request);
  try {
    const params = (request.params && typeof request.params === "object" ? request.params : {}) as Record<string, unknown>;
    if (request.method === "initialize") {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return reply(id, { protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0], capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "rebook-studio", title: "Rebook studio", version: "1.0.0" }, instructions: INSTRUCTIONS });
    }
    if (request.method.startsWith("notifications/")) return undefined;
    if (request.method === "ping") return reply(id, {});
    if (request.method === "tools/list") return reply(id, { tools });
    if (request.method === "tools/call") {
      const name = typeof params.name === "string" ? params.name : "";
      if (!tools.some((tool) => tool.name === name)) throw new RpcError(-32602, `Unknown tool: ${name}`);
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
      try {
        const result = await call(name, args, { ...context, repository });
        return reply(id, { content: [{ type: "text", text: result.text }], structuredContent: result.data });
      } catch (error) {
        // Tool failures are results the agent can read and act on, not protocol errors.
        const text = error instanceof z.ZodError ? `Invalid input: ${error.issues.map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`).join("; ")}`
          : error instanceof StoreError ? error.message : error instanceof PayPalError ? "PayPal could not create this payment right now. Try again in a minute." : "Something went wrong. Try again.";
        if (!(error instanceof z.ZodError || error instanceof StoreError || error instanceof PayPalError)) console.error("mcp tool failed", name, error);
        return reply(id, { content: [{ type: "text", text }], isError: true });
      }
    }
    throw new RpcError(-32601, `Method not found: ${request.method}`);
  } catch (error) {
    if (notification) return undefined;
    return error instanceof RpcError ? failure(id, error.code, error.message) : failure(id, -32603, "Internal error.");
  }
}
