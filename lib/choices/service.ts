import { z } from "zod";
import { draftCustomerMessages } from "../ai/messages";
import { pausedSessionIds, seatsLeft, sessionAvailable } from "../checkout/service";
import { addLocalDays, fromCents, localParts, overlaps, toCents, zonedTimeToUtc } from "../domain/time";
import type { State } from "../domain/types";
import { executeRefund } from "../executor/refund";
import { recoveryOutcomes } from "../recovery/outcomes";
import { remainingCaptured as capturedBalance, spendableCredit, unreturnedRedemption } from "../credits/balance";
import { type OutboxCustomer } from "./outbox";
import { deliverableAddress } from "./email-content";
import { customerLinkReadableUntil, getRepository, StoreError, withWorkspaceLock, type Credit, type CustomerLink, type Repository, type StoredPlan } from "../store";

export const ChoiceTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ChoiceInputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("keep") }),
  z.strictObject({ action: z.literal("move"), sessionId: z.string().min(1).max(100) }),
  z.strictObject({ action: z.literal("refund") }),
  z.strictObject({ action: z.literal("credit") }),
]);
export type ChoiceInput = z.infer<typeof ChoiceInputSchema>;

export function createCustomerLinks(plan: StoredPlan, before: State, after: State, repository: Repository): void {
  const messages = draftCustomerMessages(plan, before);
  const checkouts = new Map(repository.listCheckout(plan.workspaceId).map((row) => [row.id, row]));
  for (const action of plan.bookingActions) {
    const booking = before.bookings.find((item) => item.id === action.bookingId)!;
    const original = before.sessions.find((item) => item.id === booking.sessionId)!;
    const current = after.sessions.find((item) => item.id === booking.sessionId);
    const message = messages.find((item) => item.bookingId === booking.id)!;
    const checkout = checkouts.get(booking.id);
    let body = checkout ? message.body.replace(`Hi ${message.customerName},`, () => `Hi ${checkout.customer.name},`) : message.body;
    if (checkout?.paidWith === "credit" && action.action === "refund") body = body.replace(`We'll arrange a refund of ${before.studio.currency} ${action.amount}.`, `${before.studio.currency} ${action.amount} will be returned to your studio credit.`);
    repository.createCustomerLink({ workspaceId: plan.workspaceId, planId: plan.id, bookingId: booking.id,
      kind: action.action === "refund" ? "receipt" : "choice",
      expiresAt: Math.min(Date.now() + 7 * 86_400_000, Date.parse(current?.start ?? original.start)),
      before: original, after: action.action === "refund" ? undefined : current,
      message: { subject: message.subject, body: body.replace("Doesn't work? Reply for a refund.", "Choose below to keep your new time, find another class, or take a refund.") },
    });
  }
}

export function requireLink(token: string, repository: Repository): CustomerLink {
  const link = repository.customerLinkByToken(ChoiceTokenSchema.parse(token));
  if (!link) throw new StoreError(404, "This private link is unavailable.");
  if (customerLinkReadableUntil(link) <= Date.now()) throw new StoreError(410, "This private link has expired. Please contact the studio.");
  repository.requireReadyWorkspace(link.workspaceId);
  return link;
}

function remainingCaptured(link: CustomerLink, repository: Repository): number {
  return capturedBalance(link.workspaceId, link.bookingId, repository);
}

function creditPayment(link: CustomerLink, repository: Repository) {
  const checkout = repository.listCheckout(link.workspaceId).find((row) => row.id === link.bookingId && row.paidWith === "credit");
  const credit = checkout && repository.listCredits(link.workspaceId).find((item) => item.id === checkout.creditId);
  return { paidWith: checkout?.paidWith, remaining: credit ? unreturnedRedemption(credit, link.bookingId) : 0 };
}

function alternatives(link: CustomerLink, repository: Repository) {
  const { state } = repository.requireReadyWorkspace(link.workspaceId);
  const booking = state.bookings.find((item) => item.id === link.bookingId)!;
  const week = localParts(state.studio.weekStart, state.studio.timezone).dateKey;
  const end = Date.parse(zonedTimeToUtc(addLocalDays(week, 7), "00:00", state.studio.timezone));
  const payment = creditPayment(link, repository);
  const maxPrice = Math.min(toCents(booking.amount), payment.paidWith ? payment.remaining : remainingCaptured(link, repository));
  const paused = pausedSessionIds(link.workspaceId, repository);
  return state.sessions.filter((session) => session.id !== booking.sessionId && sessionAvailable(state, session, paused)
    && Date.parse(session.start) >= Date.parse(state.studio.weekStart) && Date.parse(session.start) < end
    && toCents(session.price) <= maxPrice && seatsLeft(state, session, repository.listCheckout(link.workspaceId)) > 0
    && !state.bookings.some((other) => other.id !== booking.id && other.customerId === booking.customerId && ["confirmed", "moved"].includes(other.status)
      && state.sessions.some((booked) => booked.id === other.sessionId && overlaps(booked.start, booked.end, session.start, session.end))))
    .sort((a, b) => Number(b.classType === link.before.classType) - Number(a.classType === link.before.classType) || a.start.localeCompare(b.start))
    .map((session) => ({ ...session, seatsLeft: seatsLeft(state, session, repository.listCheckout(link.workspaceId)),
      instructor: state.instructors.find((item) => item.id === session.instructorId)?.name ?? "Studio team",
      difference: fromCents(maxPrice - toCents(session.price)) }));
}

function receiptFor(link: CustomerLink, repository: Repository) {
  const requestId = link.kind === "receipt" ? `${link.planId}:${link.bookingId}` : link.reply?.requestId;
  const event = repository.latestMoneyEvents(link.workspaceId).find((item) => item.kind === "refund" && item.requestId === requestId);
  return event ? { amount: event.amount, status: event.status, paypalId: event.paypalId, error: event.error } : undefined;
}

export function view(link: CustomerLink, repository: Repository) {
  const { state } = repository.requireReadyWorkspace(link.workspaceId);
  const booking = state.bookings.find((item) => item.id === link.bookingId);
  if (!booking) throw new StoreError(410, "This booking is no longer available.");
  const describe = (session: State["sessions"][number]) => ({ ...session,
    instructor: state.instructors.find((item) => item.id === session.instructorId)?.name ?? "Studio team" });
  const current = state.sessions.find((item) => item.id === booking.sessionId);
  const newest = repository.listCustomerLinks(link.workspaceId).filter((item) => item.bookingId === link.bookingId).at(-1);
  const credit = repository.listCredits(link.workspaceId).find((item) => item.linkId === link.id);
  const payment = creditPayment(link, repository);
  const canChoose = link.expiresAt > Date.now() && link.kind === "choice" && !link.reply?.requestId && link.reply?.action !== "credit" && newest?.id === link.id
    && ["confirmed", "moved"].includes(booking.status) && !!current && sessionAvailable(state, current);
  return { studio: { name: state.studio.name, timezone: state.studio.timezone }, message: link.message,
    before: describe(link.before), after: current && link.kind === "choice" ? describe(current) : undefined,
    reply: link.reply ? { action: link.reply.action, at: link.reply.at } : undefined,
    kind: link.kind, canChoose, choicesClosed: link.expiresAt <= Date.now(), expiresAt: link.expiresAt, simulated: !!booking.payment?.simulated,
    refundable: fromCents(remainingCaptured(link, repository)), ...(payment.paidWith ? { paidWith: payment.paidWith, creditRefundable: fromCents(payment.remaining) } : {}), receipt: receiptFor(link, repository),
    ...(credit ? { credit: { ...spendableCredit(credit, repository), path: creditPath(credit, repository), readableUntil: customerLinkReadableUntil(link),
      emailed: repository.listDeliveries(link.workspaceId).find((item) => item.kind === `credit:${link.id}`)?.status } } : {}),
    alternatives: canChoose ? alternatives(link, repository) : [] };
}
export type CustomerChoiceView = ReturnType<typeof view>;
/** The credit's own link outlives the choice page; the token rides in the fragment, never in a request. */
export function creditPath(credit: Credit, repository: Repository): string {
  return `/b/${repository.requireWorkspace(credit.workspaceId).bookingId}#credit=${repository.creditToken(credit)}`;
}

async function finishRefund(link: CustomerLink, repository: Repository, owner: string) {
  if (link.kind === "receipt") {
    const plan = repository.getPlan(link.workspaceId, link.planId);
    const action = plan?.bookingActions.find((item) => item.bookingId === link.bookingId && item.action === "refund");
    if (action) await executeRefund(link.workspaceId, action, `${link.planId}:${link.bookingId}`, repository, () => repository.renewLock(link.workspaceId, owner));
    return;
  }
  if (!link.reply?.requestId) return;
  await executeRefund(link.workspaceId, { bookingId: link.bookingId, amount: link.reply.amount,
    reason: link.reply.action === "move" ? "Customer chose a lower-priced class" : "Customer requested a refund",
    partial: link.reply.action === "move" }, link.reply.requestId, repository, () => repository.renewLock(link.workspaceId, owner));
}

export async function customerChoice(token: string, repository = getRepository()): Promise<CustomerChoiceView> {
  let link = requireLink(token, repository);
  const receipt = receiptFor(link, repository);
  if ((link.reply?.requestId || link.kind === "receipt") && (!receipt || ["REQUESTED", "PENDING"].includes(receipt.status))) {
    await withWorkspaceLock(repository, link.workspaceId, async (owner) => {
      link = requireLink(token, repository);
      await finishRefund(link, repository, owner);
    });
  }
  return view(link, repository);
}

export async function submitChoice(token: string, input: ChoiceInput, repository = getRepository()): Promise<CustomerChoiceView> {
  input = ChoiceInputSchema.parse(input);
  const initial = requireLink(token, repository);
  return withWorkspaceLock(repository, initial.workspaceId, async (owner) => {
    let link = requireLink(token, repository);
    if (link.kind !== "choice") throw new StoreError(409, "This link is a refund receipt only.");
    if (link.reply?.action === "credit" || repository.listCredits(link.workspaceId).some((item) => item.bookingId === link.bookingId)) {
      if (input.action !== "credit") throw new StoreError(409, "Your studio credit choice is final.");
      return view(link, repository);
    }
    if (link.reply?.requestId) {
      if (input.action !== link.reply.action || (input.action === "move" && input.sessionId !== link.reply.sessionId)) throw new StoreError(409, "Your choice is final once a refund starts.");
      await finishRefund(link, repository, owner);
      return view(link, repository);
    }
    if (link.expiresAt <= Date.now()) throw new StoreError(410, "Choices closed at the class deadline. Your booking outcome and receipt remain available here.");
    if (!view(link, repository).canChoose) throw new StoreError(409, "This booking has changed. Please use the studio's latest message.");
    repository.transaction(() => {
      const { state } = repository.requireReadyWorkspace(link.workspaceId);
      const booking = state.bookings.find((item) => item.id === link.bookingId)!;
      let amount = "0.00";
      let requestId: string | undefined;
      if (input.action === "move") {
        const target = alternatives(link, repository).find((item) => item.id === input.sessionId);
        if (!target) throw new StoreError(409, "This class is full or no longer eligible. Please choose another class.");
        amount = target.difference;
        if (toCents(amount) > 0) requestId = `choice:${link.id}`;
        booking.sessionId = target.id; booking.amount = target.price; booking.status = "moved";
        link = { ...link, expiresAt: Math.min(link.expiresAt, Date.parse(target.start)) };
      } else if (input.action === "credit") {
        if (creditPayment(link, repository).paidWith) throw new StoreError(409, "This booking was paid with studio credit.");
        amount = fromCents(remainingCaptured(link, repository));
        if (toCents(amount) <= 0) throw new StoreError(409, "There is no captured amount available for studio credit.");
        booking.status = "cancelled";
        repository.createCredit({ workspaceId: link.workspaceId, linkId: link.id, bookingId: booking.id, customerId: booking.customerId, amount });
      } else if (input.action === "refund") {
        const payment = creditPayment(link, repository);
        amount = fromCents(payment.paidWith ? payment.remaining : remainingCaptured(link, repository));
        if (toCents(amount) <= 0) throw new StoreError(409, "There is no captured amount available to refund.");
        // Seed booking IDs repeat across workspaces; the durable link identifies this operation.
        requestId = `choice:${link.id}`;
        booking.status = "refund_pending";
      }
      link = { ...link, reply: { action: input.action, ...(input.action === "move" ? { sessionId: input.sessionId } : {}), amount, requestId, at: new Date().toISOString() } };
      repository.saveState(link.workspaceId, state);
      repository.saveCustomerLink(link);
    });
    await finishRefund(link, repository, owner);
    return view(link, repository);
  });
}

/** Owner retry for a customer's own refund; the executor still replays only after PayPal proves it absent. */
export async function retryChoiceRefund(workspaceId: string, requestId: string, repository = getRepository()) {
  return withWorkspaceLock(repository, workspaceId, async (owner) => {
    const link = repository.listCustomerLinks(workspaceId).find((item) => item.kind === "choice" && item.reply?.requestId === requestId);
    if (!link) throw new StoreError(404, "Refund not found");
    await finishRefund(link, repository, owner);
    return receiptFor(link, repository);
  });
}

export function ownerCustomerChoices(workspaceId: string, repository = getRepository()) {
  const { state } = repository.requireWorkspace(workspaceId);
  const links = repository.listCustomerLinks(workspaceId);
  const outbox = new Map<string, OutboxCustomer>();
  const plans = repository.listPlans(workspaceId);
  const checkouts = repository.listCheckout(workspaceId), deliveries = repository.listDeliveries(workspaceId);
  for (const link of links.toSorted((a, b) => Number(b.kind === "choice") - Number(a.kind === "choice"))) {
    const booking = state.bookings.find((item) => item.id === link.bookingId);
    if (!booking) continue;
    const key = `${link.planId}:${booking.customerId}`;
    const row = outbox.get(key) ?? { customerId: booking.customerId,
      customerName: state.customers.find((item) => item.id === booking.customerId)?.name ?? "Customer", planId: link.planId, changes: [] };
    const action = plans.find((plan) => plan.id === link.planId)?.bookingActions.find((item) => item.bookingId === link.bookingId);
    const reply = link.reply;
    const receipt = receiptFor(link, repository);
    row.changes.push({ bookingId: link.bookingId, ...link.message, kind: link.kind,
      path: `/c/${repository.customerToken(link)}`, expiresAt: link.expiresAt, sentAt: link.sentAt,
      reply: receipt?.status === "CREDIT_RESTORED" ? { at: reply?.at ?? link.createdAt, status: "returned to your studio credit" }
        : reply ? { at: reply.at, status: reply.action === "credit" ? `kept a $${Number(reply.amount)} studio credit` : reply.action === "refund" ? booking.status === "refunded" ? "refunded" : "refund requested" : reply.action === "move" ? "chose another class" : action?.action === "move" ? "moved" : "kept" } : undefined });
    outbox.set(key, row);
  }
  for (const row of outbox.values()) {
    const customer = state.customers.find((item) => item.id === row.customerId);
    row.emailDeliverable = !!customer && deliverableAddress(customer.email, row.changes.map((change) => change.bookingId), checkouts);
    for (const kind of ["message", "reminder"] as const) {
      const delivery = deliveries.find((item) => item.planId === row.planId && item.customerId === row.customerId && item.kind === kind);
      if (delivery) row[kind === "message" ? "delivery" : "reminderDelivery"] = { status: delivery.status, updatedAt: delivery.updatedAt };
    }
  }
  const creditPaidBookingIds = checkouts.filter((row) => row.paidWith === "credit").map((row) => row.id);
  return { outcomes: recoveryOutcomes(state, plans, repository.listLedger(workspaceId), links, new Set(creditPaidBookingIds)), creditPaidBookingIds,
    outbox: [...outbox.values()],
    links: links.map((link) => ({ bookingId: link.bookingId, planId: link.planId, kind: link.kind,
    path: `/c/${repository.customerToken(link)}`, expiresAt: link.expiresAt })),
    replies: links.filter((link) => link.reply).map((link) => {
      const reply = link.reply!;
      const booking = state.bookings.find((item) => item.id === link.bookingId);
      const customer = state.customers.find((item) => item.id === booking?.customerId)?.name ?? "Customer";
      const session = state.sessions.find((item) => item.id === (reply.sessionId ?? booking?.sessionId));
      const when = session ? new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, weekday: "long", hour: "numeric", minute: "2-digit" }).format(new Date(session.start)) : "their class";
      const receipt = receiptFor(link, repository);
      const money = receipt?.status === "CREDIT_RESTORED" ? ` ($${receipt.amount} returned to your studio credit)`
        : receipt ? ` ($${receipt.amount}, ${receipt.status === "SIMULATED" ? "simulated" : "PayPal"} ${receipt.paypalId || "pending"} · ${receipt.status.toLowerCase()})` : "";
      return { id: link.id, at: reply.at, action: reply.action,
        text: `${customer} ${reply.action === "credit" ? `kept a $${Number(reply.amount)} studio credit` : reply.action === "refund" ? "took a refund" : reply.action === "move" ? `picked ${session?.title ?? "another class"} on ${when}` : `kept ${when}`}${money}` };
    }).sort((a, b) => b.at.localeCompare(a.at)) };
}
export type OwnerCustomerChoices = ReturnType<typeof ownerCustomerChoices>;

export async function markCustomerContact(workspaceId: string, planId: string, customerId: string, sent: boolean, repository = getRepository()) {
  return withWorkspaceLock(repository, workspaceId, () => repository.transaction(() => {
    const { state } = repository.requireReadyWorkspace(workspaceId);
    const links = repository.listCustomerLinks(workspaceId).filter((link) => link.planId === planId
      && state.bookings.some((booking) => booking.id === link.bookingId && booking.customerId === customerId));
    if (!links.length) throw new StoreError(404, "Customer message not found in this recovery.");
    const sentAt = sent ? new Date().toISOString() : undefined;
    for (const link of links) repository.saveCustomerLink({ ...link, sentAt });
    return ownerCustomerChoices(workspaceId, repository);
  }));
}
