import { z } from "zod";
import { draftCustomerMessages } from "../ai/messages";
import { seatsLeft, sessionAvailable } from "../checkout/service";
import { addLocalDays, fromCents, localParts, overlaps, toCents, zonedTimeToUtc } from "../domain/time";
import type { State } from "../domain/types";
import { executeRefund } from "../executor/refund";
import { recoveryOutcomes } from "../recovery/outcomes";
import { getRepository, StoreError, withWorkspaceLock, type CustomerLink, type Repository, type StoredPlan } from "../store";

export const ChoiceTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ChoiceInputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("keep") }),
  z.strictObject({ action: z.literal("move"), sessionId: z.string().min(1).max(100) }),
  z.strictObject({ action: z.literal("refund") }),
]);
export type ChoiceInput = z.infer<typeof ChoiceInputSchema>;

export function createCustomerLinks(plan: StoredPlan, before: State, after: State, repository: Repository): void {
  const messages = draftCustomerMessages(plan, before);
  for (const action of plan.bookingActions) {
    const booking = before.bookings.find((item) => item.id === action.bookingId)!;
    const original = before.sessions.find((item) => item.id === booking.sessionId)!;
    const current = after.sessions.find((item) => item.id === booking.sessionId);
    const message = messages.find((item) => item.bookingId === booking.id)!;
    repository.createCustomerLink({ workspaceId: plan.workspaceId, planId: plan.id, bookingId: booking.id,
      kind: action.action === "refund" ? "receipt" : "choice",
      expiresAt: Math.min(Date.now() + 7 * 86_400_000, Date.parse(current?.start ?? original.start)),
      before: original, after: action.action === "refund" ? undefined : current,
      message: { subject: message.subject, body: message.body.replace("Doesn't work? Reply for a refund.", "Choose below to keep your new time, find another class, or take a refund.") },
    });
  }
}

function requireLink(token: string, repository: Repository): CustomerLink {
  const link = repository.customerLinkByToken(ChoiceTokenSchema.parse(token));
  if (!link) throw new StoreError(404, "This private link is unavailable.");
  if (link.expiresAt <= Date.now()) throw new StoreError(410, "This private link has expired. Please contact the studio.");
  repository.requireReadyWorkspace(link.workspaceId);
  return link;
}

function remainingCaptured(link: CustomerLink, repository: Repository): number {
  const { state } = repository.requireReadyWorkspace(link.workspaceId);
  const booking = state.bookings.find((item) => item.id === link.bookingId);
  const capture = repository.latestMoneyEvents(link.workspaceId).find((event) => event.kind === "capture" && event.paypalId === booking?.payment?.captureId);
  if (!capture || !["COMPLETED", "SIMULATED"].includes(capture.status)) return 0;
  return Math.max(0, toCents(capture.amount) - repository.latestMoneyEvents(link.workspaceId)
    .filter((event) => event.kind === "refund" && event.captureId === capture.captureId && ["REQUESTED", "PENDING", "COMPLETED", "SIMULATED"].includes(event.status))
    .reduce((sum, event) => sum + toCents(event.amount), 0));
}

function alternatives(link: CustomerLink, repository: Repository) {
  const { state } = repository.requireReadyWorkspace(link.workspaceId);
  const booking = state.bookings.find((item) => item.id === link.bookingId)!;
  const week = localParts(state.studio.weekStart, state.studio.timezone).dateKey;
  const end = Date.parse(zonedTimeToUtc(addLocalDays(week, 7), "00:00", state.studio.timezone));
  const maxPrice = Math.min(toCents(booking.amount), remainingCaptured(link, repository));
  return state.sessions.filter((session) => session.id !== booking.sessionId && sessionAvailable(state, session)
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

function view(link: CustomerLink, repository: Repository) {
  const { state } = repository.requireReadyWorkspace(link.workspaceId);
  const booking = state.bookings.find((item) => item.id === link.bookingId);
  if (!booking) throw new StoreError(410, "This booking is no longer available.");
  const describe = (session: State["sessions"][number]) => ({ ...session,
    instructor: state.instructors.find((item) => item.id === session.instructorId)?.name ?? "Studio team" });
  const current = state.sessions.find((item) => item.id === booking.sessionId);
  const newest = repository.listCustomerLinks(link.workspaceId).filter((item) => item.bookingId === link.bookingId).at(-1);
  const canChoose = link.kind === "choice" && !link.reply?.requestId && newest?.id === link.id
    && ["confirmed", "moved"].includes(booking.status) && !!current && sessionAvailable(state, current);
  return { studio: { name: state.studio.name, timezone: state.studio.timezone }, message: link.message,
    before: describe(link.before), after: current && link.kind === "choice" ? describe(current) : undefined,
    reply: link.reply ? { action: link.reply.action, at: link.reply.at } : undefined,
    kind: link.kind, canChoose, expiresAt: link.expiresAt, simulated: !!booking.payment?.simulated,
    refundable: fromCents(remainingCaptured(link, repository)), receipt: receiptFor(link, repository),
    alternatives: canChoose ? alternatives(link, repository) : [] };
}
export type CustomerChoiceView = ReturnType<typeof view>;

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
    if (link.reply?.requestId) {
      if (input.action !== link.reply.action || (input.action === "move" && input.sessionId !== link.reply.sessionId)) throw new StoreError(409, "Your choice is final once a refund starts.");
      await finishRefund(link, repository, owner);
      return view(link, repository);
    }
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
      } else if (input.action === "refund") {
        amount = fromCents(remainingCaptured(link, repository));
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

export function ownerCustomerChoices(workspaceId: string, repository = getRepository()) {
  const { state } = repository.requireWorkspace(workspaceId);
  const links = repository.listCustomerLinks(workspaceId);
  return { outcomes: recoveryOutcomes(state, repository.listPlans(workspaceId), repository.listLedger(workspaceId), links),
    links: links.map((link) => ({ bookingId: link.bookingId, planId: link.planId, kind: link.kind,
    path: `/c/${repository.customerToken(link)}`, expiresAt: link.expiresAt })),
    replies: links.filter((link) => link.reply).map((link) => {
      const reply = link.reply!;
      const booking = state.bookings.find((item) => item.id === link.bookingId);
      const customer = state.customers.find((item) => item.id === booking?.customerId)?.name ?? "Customer";
      const session = state.sessions.find((item) => item.id === (reply.sessionId ?? booking?.sessionId));
      const when = session ? new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, weekday: "long", hour: "numeric", minute: "2-digit" }).format(new Date(session.start)) : "their class";
      const receipt = receiptFor(link, repository);
      const money = receipt ? ` ($${receipt.amount}, ${receipt.status === "SIMULATED" ? "simulated" : "PayPal"} ${receipt.paypalId || "pending"} · ${receipt.status.toLowerCase()})` : "";
      return { id: link.id, at: reply.at, action: reply.action,
        text: `${customer} ${reply.action === "refund" ? "took a refund" : reply.action === "move" ? `picked ${session?.title ?? "another class"} on ${when}` : `kept ${when}`}${money}` };
    }).sort((a, b) => b.at.localeCompare(a.at)) };
}
export type OwnerCustomerChoices = ReturnType<typeof ownerCustomerChoices>;
