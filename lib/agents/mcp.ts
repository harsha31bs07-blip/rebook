import { createHash } from "node:crypto";
import { z } from "zod";
import { bookingCatalog, createOrder, type CheckoutInput } from "../checkout/service";
import { ChoiceInputSchema, ChoiceTokenSchema, customerChoice, submitChoice } from "../choices/service";
import { approvalLink, getOrder, PayPalError } from "../paypal/client";
import { getRepository, StoreError, type Repository } from "../store";
import { limits } from "../api/limits";
import { joinWaitlist } from "../waitlist/service";
import { localClass } from "../webmcp/tools";
import { toCents } from "../domain/time";

/**
 * A remote MCP server per studio (the public booking capability), so a customer's own AI agent can find, book or
 * rebook a class. Money rule: the agent never pays. Booking returns a PayPal link the person approves on PayPal;
 * refunds and cheaper moves return the person's private page for approval.
 */
export const MCP_VERSIONS = ["2025-06-18", "2025-03-26"];
const INSTRUCTIONS = "Rebook studio tools. You can list classes, book one for the person you help, join a waitlist, or answer their private rebooking link. You never pay: book_class returns a PayPal link the person opens to approve the payment. Refunds and cheaper moves that return money need the person: give them the returned reviewUrl to confirm on their private page. You cannot confirm for them. Returning a pack or membership visit applies directly.";
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
    description: "Answer the person's private rebooking link: keep, move (with classId from get_rebooking_options), credit, or refund. Refunds and cheaper moves returning money return needs_person with reviewUrl: give the person that link to confirm on their private page. You cannot confirm for them. Keep, moves with zero difference, studio credit, and pack or membership visit returns apply directly.",
    inputSchema: { type: "object", properties: { link: str(300, "The person's private link or its token"), option: { type: "string", enum: ["keep", "move", "credit", "refund"] },
      classId: str(100, "For move: a classId from get_rebooking_options") }, required: ["link", "option"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
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

const bookingOrders = new WeakMap<Repository, Map<string, ReturnType<typeof createOrder>>>();
function agentOrder(context: Context, input: CheckoutInput, requestId: string) {
  let pending = bookingOrders.get(context.repository);
  if (!pending) { pending = new Map(); bookingOrders.set(context.repository, pending); }
  const key = `${context.workspaceId}:${requestId}`, existing = pending.get(key);
  if (existing) return existing;
  // Share the in-flight request too: checkout's workspace lease rejects concurrent writers.
  const order = createOrder(context.workspaceId, input, requestId, context.repository,
    { returnUrl: `${context.origin}/b/${context.bookingId}/paid`, cancelUrl: `${context.origin}/b/${context.bookingId}`,
      brandName: context.repository.requireReadyWorkspace(context.workspaceId).state.studio.name }).finally(() => pending.delete(key));
  pending.set(key, order);
  return order;
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
    const { state } = context.repository.requireReadyWorkspace(context.workspaceId), email = input.email.toLowerCase();
    const person = state.customers.find((customer) => customer.email.toLowerCase() === email);
    if (person && state.bookings.some((booking) => booking.sessionId === input.classId && booking.customerId === person.id && ["confirmed", "moved"].includes(booking.status))) {
      return { data: { status: "already_booked", class: found }, text: `${input.name} is already booked in ${found.title} (${found.weekday} ${found.startTime}). Nothing more to pay.` };
    }
    const reservations = context.repository.listCheckout(context.workspaceId).filter((row) => row.sessionId === input.classId && row.customer.email.toLowerCase() === email);
    if (reservations.some((row) => row.status === "capturing")) return { data: { status: "confirming_payment", class: found },
      text: `The payment for ${found.title} is being confirmed. Check its status before starting another booking.` };
    const active = reservations.find((row) => row.status === "pending" && row.expiresAt > Date.now());
    if (!active && found.status === "paused") throw new StoreError(409, "This class is paused while the studio confirms a change. Try another class.");
    if (!active && found.seatsLeft <= 0) throw new StoreError(409, "This class is full. Use join_waitlist to join its waitlist.");
    // Agent bookings hold seats like the booking page, so they share its checkout limits.
    if (!active) limits.take([{ key: `checkout-client:${context.ip ?? "agent"}`, max: 60, ms: 60_000 }, { key: `checkout-workspace:${context.workspaceId}`, max: 120, ms: 60_000 }, { key: "checkout-global", max: 600, ms: 60_000 }]);
    const holdsClass = (id: string) => state.bookings.some((booking) => booking.id === id && booking.sessionId === input.classId && ["confirmed", "moved"].includes(booking.status));
    const generation = reservations.filter((row) => row.status === "failed" || (row.status === "pending" && row.expiresAt <= Date.now()) || (row.status === "confirmed" && !holdsClass(row.id))).length;
    const requestId = active?.requestId ?? `agent-${createHash("sha256").update(`${input.classId}|${email}|${generation}`).digest("hex")}`;
    const studio = state.studio;
    const offer = active?.waitlistOfferId && context.repository.listWaitlistOffers(context.workspaceId).find((item) => item.id === active.waitlistOfferId);
    const order = active?.orderId ? { orderId: active.orderId } : await agentOrder(context,
      { sessionId: input.classId, customer: active?.customer ?? { name: input.name, email: input.email }, availability: active?.availability,
        ...(offer ? { waitlistToken: context.repository.waitlistToken(offer) } : {}) }, requestId);
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
    const input = z.strictObject({ link: z.unknown(), option: z.enum(["keep", "move", "credit", "refund"]), classId: z.string().max(100).optional() }).parse(args);
    if (input.option === "move" && !input.classId) throw new StoreError(400, "Moving needs a classId from get_rebooking_options.");
    const current = await customerChoice(token, context.repository);
    const target = input.option === "move" ? current.alternatives.find((item) => item.id === input.classId) : undefined;
    if (input.option === "move" && !target) throw new StoreError(409, "This class is full or no longer eligible. Please choose another class.");
    if ((input.option === "refund" && !current.entitlement) || (target && toCents(target.difference) > 0)) {
      const amount = target?.difference ?? current.creditRefundable ?? current.refundable;
      const destination = current.paidWith === "credit" ? "studio credit" : "their original payment";
      const reason = target ? "Moving to this cheaper class returns a partial refund." : "A refund needs the person to approve.";
      const reviewUrl = `${context.origin}/c/${token}`;
      return { data: { status: "needs_person", reason, amount, destination, reviewUrl },
        text: `${reason} Give the person this link to confirm ${money(amount)} back to ${destination} on their private page:\n${reviewUrl}\nYou cannot confirm for them.` };
    }
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
