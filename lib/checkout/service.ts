import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Session, State } from "../domain/types";
import { fromCents, overlaps, toCents } from "../domain/time";
import { activeConstraints } from "../solver/constraints";
import { captureOrder, createBookingOrder, getOrder, PayPalError, type PayPalOrder } from "../paypal/client";
import { getRepository, StoreError, withWorkspaceLock, type CheckoutReservation, type WaitlistOffer, type Repository } from "../store";
import { envLimit, limits } from "../api/limits";
import { spendableCredit } from "../credits/balance";

import { checkoutHoldsSeat, heldOffers, offerHoldsSeat } from "../waitlist/capacity";

export const WaitlistTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const CheckoutInputSchema = z.strictObject({
  sessionId: z.string().min(1).max(100),
  waitlistToken: WaitlistTokenSchema.optional(),
  customer: z.strictObject({ name: z.string().trim().min(1).max(100), email: z.string().trim().pipe(z.email().max(254)) }),
  availability: z.strictObject({
    times: z.array(z.enum(["mornings", "afternoons", "evenings"])).max(3).refine((values) => new Set(values).size === values.length, "Choose distinct times").optional(),
    days: z.array(z.enum(["weekdays", "weekends"])).max(2).refine((values) => new Set(values).size === values.length, "Choose distinct days").optional(),
    acceptsSubstitute: z.boolean().optional(),
  }).optional(),
});
export type CheckoutInput = z.infer<typeof CheckoutInputSchema>;
export const CreditTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const CreditCheckoutInputSchema = CheckoutInputSchema.extend({ creditToken: CreditTokenSchema });
export type CreditCheckoutInput = z.infer<typeof CreditCheckoutInputSchema>;
function requireCredit(workspaceId: string, token: string, repository: Repository) {
  repository.requireReadyWorkspace(workspaceId);
  const credit = repository.creditByToken(CreditTokenSchema.parse(token));
  if (!credit || credit.workspaceId !== workspaceId) throw new StoreError(404, "This studio credit is unavailable.");
  return credit;
}
export function studioCredit(workspaceId: string, token: string, repository = getRepository()) {
  const credit = requireCredit(workspaceId, token, repository);
  return spendableCredit(credit, repository);
}
export async function redeemCredit(workspaceId: string, input: CreditCheckoutInput, requestId: string, repository = getRepository()): Promise<Receipt> {
  input = CreditCheckoutInputSchema.parse(input);
  if (input.waitlistToken) throw new StoreError(409, "Please use your waitlist offer to claim this spot.");
  return withWorkspaceLock(repository, workspaceId, () => repository.transaction(() => {
    const credit = requireCredit(workspaceId, input.creditToken, repository);
    const previous = repository.listCheckout(workspaceId).find((row) => row.requestId === requestId || row.requestAliases?.includes(requestId));
    if (previous) {
      if (previous.paidWith !== "credit" || previous.creditId !== credit.id || previous.sessionId !== input.sessionId
        || JSON.stringify(previous.customer) !== JSON.stringify(input.customer) || JSON.stringify(previous.availability) !== JSON.stringify(input.availability)) {
        throw new StoreError(409, "This checkout key belongs to another booking");
      }
      return checkoutReceipt(previous, repository);
    }
    const { state } = repository.requireReadyWorkspace(workspaceId);
    if (pausedSessionIds(workspaceId, repository).has(input.sessionId)) throw new StoreError(409, BOOKING_PAUSED_MESSAGE, "BOOKING_PAUSED");
    const session = state.sessions.find((item) => item.id === input.sessionId);
    if (!session || !sessionAvailable(state, session)) throw new StoreError(409, "This class is no longer available");
    if (!seatsLeft(state, session, repository.listCheckout(workspaceId), undefined, repository.listWaitlistOffers(workspaceId))) throw new StoreError(409, "This class is full. Please choose another class.");
    const balance = spendableCredit(credit, repository);
    const price = toCents(session.price), remaining = toCents(credit.remaining);
    if (price <= 0) throw new StoreError(409, "This class cannot be purchased");
    if (balance.status !== "available" || toCents(balance.remaining) < price) throw new StoreError(409, `Your studio credit covers classes up to $${balance.remaining}.`);
    const id = randomUUID(), at = new Date().toISOString();
    const customer = state.customers.find((item) => item.email.trim().toLowerCase() === input.customer.email.trim().toLowerCase());
    const customerId = customer?.id ?? `customer-${id}`;
    if (!customer) state.customers.push({ id: customerId, ...input.customer, prefs: checkoutPreferences(input.availability) });
    else if (input.availability) customer.prefs = { ...customer.prefs, ...checkoutPreferences(input.availability) };
    state.bookings.push({ id, customerId, sessionId: session.id, amount: session.price, status: "confirmed", bookedAt: at });
    const row: CheckoutReservation = { id, workspaceId, requestId, sessionId: session.id, customer: input.customer, availability: input.availability,
      amount: session.price, currency: state.studio.currency, session, expiresAt: Date.now(), status: "confirmed", paidWith: "credit", creditId: credit.id };
    repository.saveState(workspaceId, state);
    repository.saveCheckout(row);
    repository.saveCredit({ ...credit, remaining: fromCents(remaining - price), status: remaining === price ? "redeemed" : "available",
      redemptions: [...credit.redemptions, { bookingId: id, amount: session.price, at }] });
    return checkoutReceipt(row, repository);
  }));
}
export const BOOKING_PAUSED_MESSAGE = "Schedule change in progress — booking paused";
/** Classes under review in a proposed plan, or whose substitute declined and nobody new has been asked yet. */
export function pausedSessionIds(workspaceId: string, repository = getRepository()): Set<string> {
  const sessions = repository.getWorkspace(workspaceId)?.state.sessions ?? [];
  const uncovered = repository.listCoverLinks(workspaceId).filter((link) => link.status === "declined"
    && sessions.find((session) => session.id === link.sessionId)?.instructorId === link.instructorId).map((link) => link.sessionId);
  return new Set([...repository.listPlans(workspaceId).filter((plan) => plan.status === "proposed")
    .flatMap((plan) => plan.sessionChanges.map((change) => change.sessionId)), ...uncovered]);
}
export function sessionAvailable(state: State, session: Session, paused: ReadonlySet<string> = new Set()): boolean {
  return !paused.has(session.id) && Date.parse(session.start) > Date.now() && !activeConstraints(state).some((constraint) =>
    overlaps(session.start, session.end, constraint.from, constraint.to) && (constraint.kind === "closure" ||
      (constraint.kind === "instructor_unavailable" ? constraint.instructorId === session.instructorId : constraint.roomId === session.roomId)));
}
const holdsSeat = checkoutHoldsSeat;
export function seatsLeft(state: State, session: Session, reservations: CheckoutReservation[], excluding?: string, offers: WaitlistOffer[] = [], excludingOffer?: string): number {
  return Math.max(0, session.capacity - state.bookings.filter((booking) => booking.sessionId === session.id && ["confirmed", "moved"].includes(booking.status)).length
    - reservations.filter((row) => row.id !== excluding && row.sessionId === session.id && holdsSeat(row)).length
    - heldOffers(session.id, offers, reservations, excludingOffer));
}
export function bookingCatalog(workspaceId: string, repository = getRepository()) {
  const { state } = repository.requireReadyWorkspace(workspaceId);
  const reservations = repository.listCheckout(workspaceId);
  const offers = repository.listWaitlistOffers(workspaceId);
  const paused = pausedSessionIds(workspaceId, repository);
  const { name, timezone, weekStart, currency } = state.studio;
  return { studio: { name, timezone, weekStart, currency }, sessions: state.sessions.filter((session) => sessionAvailable(state, session)).sort((a, b) => a.start.localeCompare(b.start)).map((session) => ({
    id: session.id, classType: session.classType, title: session.title, start: session.start, end: session.end, price: session.price, capacity: session.capacity,
    bookingPaused: paused.has(session.id), seatsLeft: seatsLeft(state, session, reservations, undefined, offers),
    instructor: state.instructors.find((item) => item.id === session.instructorId)?.name ?? "Studio team",
    room: state.rooms.find((item) => item.id === session.roomId)?.name ?? "Studio",
  })) };
}

export async function createOrder(workspaceId: string, input: CheckoutInput, requestId: string, repository = getRepository()) {
  input = CheckoutInputSchema.parse(input);
  return withWorkspaceLock(repository, workspaceId, async (owner) => {
    let row = repository.listCheckout(workspaceId).find((item) => item.requestId === requestId || item.requestAliases?.includes(requestId));
    if (row?.paidWith === "credit") throw new StoreError(409, "This checkout key belongs to a studio credit booking");
    if (row && (row.sessionId !== input.sessionId || JSON.stringify(row.customer) !== JSON.stringify(input.customer)
      || JSON.stringify(row.availability) !== JSON.stringify(input.availability)
      || row.waitlistOfferId !== (input.waitlistToken ? repository.waitlistOfferByToken(input.waitlistToken)?.id : undefined))) throw new StoreError(409, "This checkout key belongs to another booking");
    if (row?.status === "failed" || (row?.status === "pending" && row.expiresAt <= Date.now())) throw new StoreError(410, "Your seat hold expired. Start checkout again.", "RESTART_CHECKOUT");
    if (row?.orderId) return { orderId: row.orderId };
    if (pausedSessionIds(workspaceId, repository).has(input.sessionId)) throw new StoreError(409, BOOKING_PAUSED_MESSAGE, "BOOKING_PAUSED");
    if (!row) {
      const offered = input.waitlistToken ? repository.waitlistOfferByToken(input.waitlistToken) : undefined;
      if (input.waitlistToken && (!offered || offered.workspaceId !== workspaceId || offered.sessionId !== input.sessionId
        || offered.status !== "offered")) throw new StoreError(410, "This waitlist offer is no longer available.");
      const unresolved = repository.listCheckout(workspaceId).find((item) => (item.status === "capturing" || (offered && item.waitlistOfferId === offered.id && holdsSeat(item))) &&
        item.waitlistOfferId === offered?.id && item.sessionId === input.sessionId && item.customer.email.toLowerCase() === input.customer.email.toLowerCase());
      if (unresolved?.orderId) {
        if (JSON.stringify(unresolved.customer) !== JSON.stringify(input.customer) || JSON.stringify(unresolved.availability) !== JSON.stringify(input.availability)
          || (unresolved.requestAliases?.length ?? 0) >= 32) {
          throw new StoreError(409, "Your payment is being reconciled. Check its status before starting again.", "CHECK_PAYMENT_STATUS");
        }
        // Remember every accepted key before responding, even if a webhook settles the order next.
        repository.saveCheckout({ ...unresolved, requestAliases: [...(unresolved.requestAliases ?? []), requestId] });
        return { orderId: unresolved.orderId };
      }
      const created = repository.transaction(() => {
        const { state, bookingId } = repository.requireReadyWorkspace(workspaceId);
        const session = state.sessions.find((item) => item.id === input.sessionId);
        if (!session || !sessionAvailable(state, session)) throw new StoreError(409, "This class is no longer available");
        if (toCents(session.price) <= 0) throw new StoreError(409, "This class cannot be purchased");
        limits.take([{ key: "captures", max: envLimit("MAX_REAL_CAPTURES_PER_HOUR", 1500), ms: 3_600_000 }]);
        const offer = input.waitlistToken ? repository.waitlistOfferByToken(input.waitlistToken) : undefined;
        if (input.waitlistToken) {
          const customer = state.customers.find((item) => item.id === offer?.customerId);
          if (!offer || !offerHoldsSeat(offer, repository.listCheckout(workspaceId)) || !customer
            || state.waitlist?.find((entry) => entry.id === offer.entryId)?.entitlement
            || customer.name !== input.customer.name || customer.email !== input.customer.email
            || repository.listCheckout(workspaceId).some((item) => item.waitlistOfferId === offer.id && holdsSeat(item))) {
            throw new StoreError(409, "This waitlist offer is no longer available.");
          }
        }
        if (!seatsLeft(state, session, repository.listCheckout(workspaceId), undefined, repository.listWaitlistOffers(workspaceId), offer?.id)
          || offer && state.bookings.some((booking) => booking.sessionId === session.id && booking.customerId === offer.customerId && ["confirmed", "moved"].includes(booking.status))) {
          if (offer) { repository.saveWaitlistOffer({ ...offer, status: "expired" }); return undefined; }
          throw new StoreError(409, "This class is full. Please choose another class.");
        }
        const reservationId = randomUUID();
        const reservation: CheckoutReservation = { id: reservationId, workspaceId, requestId, sessionId: session.id,
          customer: input.customer, availability: input.availability, waitlistOfferId: offer?.id, amount: session.price, currency: state.studio.currency, session,
          paypalCustomId: `${bookingId}:${reservationId}`, expiresAt: Date.now() + 10 * 60_000, status: "pending" };
        repository.saveCheckout(reservation);
        return reservation;
      });
      if (!created) throw new StoreError(409, "Sorry, this spot was just taken.");
      row = created;
    }
    const reservation = row;
    try {
      const { state } = repository.requireReadyWorkspace(workspaceId);
      const localTime = new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(reservation.session.start));
      // PayPal order metadata is visible to buyers: never send the owner capability.
      const publicReference = reservation.paypalCustomId?.split(":")[0] ?? workspaceId;
      const order = await createBookingOrder(reservation.amount, { workspaceId: publicReference, bookingId: reservation.id, requestId: reservation.id }, `${reservation.session.title} · ${localTime}`);
      if (!order.id) throw new Error("PayPal did not return an order ID");
      repository.renewLock(workspaceId, owner);
      repository.saveCheckout({ ...reservation, orderId: order.id });
      return { orderId: order.id };
    } catch (error) {
      // A lost creation response can be replayed with the same request ID until the hold expires.
      if (error instanceof PayPalError && error.status < 500 && ![408, 429].includes(error.status)) repository.saveCheckout({ ...reservation, status: "failed" });
      throw error;
    }
  });
}

function checkoutPreferences(availability: CheckoutInput["availability"]) {
  if (!availability) return { acceptsSubstitute: true, availabilityKnown: false,
    windows: Array.from({ length: 7 }, (_, weekday) => ({ weekday, from: "00:00", to: "23:59" })) };
  const periods = { mornings: { from: "07:00", to: "12:00" }, afternoons: { from: "12:00", to: "17:00" }, evenings: { from: "17:00", to: "21:00" } };
  const days = availability.days?.flatMap((day) => day === "weekdays" ? [1, 2, 3, 4, 5] : [0, 6]) ?? [0, 1, 2, 3, 4, 5, 6];
  const times = availability.times?.map((time) => periods[time]) ?? [{ from: "07:00", to: "21:00" }];
  return { acceptsSubstitute: availability.acceptsSubstitute ?? true, availabilityKnown: true,
    windows: days.sort().flatMap((weekday) => times.map((time) => ({ weekday, ...time }))) };
}

function validateCapture(row: CheckoutReservation, order: PayPalOrder) {
  const unit = order.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  if (order.id !== row.orderId || order.status !== "COMPLETED" || order.purchase_units?.length !== 1 || !capture?.id || capture.status !== "COMPLETED"
    || unit?.payments?.captures?.length !== 1 || unit.custom_id !== (row.paypalCustomId ?? `${row.workspaceId}:${row.id}`) || unit.reference_id !== row.id
    || capture.amount?.currency_code !== row.currency || capture.amount?.value !== row.amount
    || unit.amount?.currency_code !== row.currency || unit.amount?.value !== row.amount) {
    throw new StoreError(502, "PayPal capture did not match this booking. Please retry to reconcile.", "CAPTURE_MISMATCH");
  }
  return capture;
}

export function confirmOrder(row: CheckoutReservation, order: PayPalOrder, repository: Repository, insideTransaction = false, webhookConfirmed = false) {
  const capture = validateCapture(row, order);
  const persist = () => {
    // A webhook may already have confirmed (or reversed/refunded) this payment while HTTP was in flight.
    const current = repository.checkoutByOrder(row.workspaceId, row.orderId!);
    if (current?.status === "confirmed") {
      if (current.captureId !== capture.id) throw new StoreError(502, "PayPal capture changed for this booking", "CAPTURE_MISMATCH");
      if (webhookConfirmed) repository.saveCheckout({ ...current, webhookConfirmed: true });
      return;
    }
    const { state } = repository.requireReadyWorkspace(row.workspaceId);
    if (!state.bookings.some((booking) => booking.id === row.id)) {
      const offer = row.waitlistOfferId ? repository.listWaitlistOffers(row.workspaceId).find((item) => item.id === row.waitlistOfferId) : undefined;
      if (offer) {
        const session = state.sessions.find((item) => item.id === row.sessionId);
        if (!session || offer.status !== "offered" || !seatsLeft(state, session, repository.listCheckout(row.workspaceId), row.id, repository.listWaitlistOffers(row.workspaceId), offer.id)
          || state.bookings.some((booking) => booking.sessionId === row.sessionId && booking.customerId === offer.customerId && ["confirmed", "moved"].includes(booking.status))) {
          repository.saveWaitlistOffer({ ...offer, status: offer.status === "withdrawn" ? "withdrawn" : "expired", bookingId: row.id });
          state.bookings.push({ id: row.id, customerId: offer.customerId, sessionId: row.sessionId, amount: row.amount, status: "refund_pending",
            bookedAt: new Date().toISOString(), payment: { orderId: row.orderId!, captureId: capture.id, simulated: false } });
          repository.saveState(row.workspaceId, state);
          repository.appendLedger({ workspaceId: row.workspaceId, bookingId: row.id, kind: "capture", amount: row.amount,
            paypalId: capture.id, captureId: capture.id, requestId: `checkout:${row.id}`, status: "COMPLETED", debugId: order.debugId });
          repository.appendLedger({ workspaceId: row.workspaceId, bookingId: row.id, kind: "refund", amount: row.amount,
            paypalId: "", captureId: capture.id, requestId: `waitlist:${row.id}`, status: "FAILED",
            error: "This waitlist payment completed after the seat was lost. Retry to refund it." });
          repository.saveCheckout({ ...row, captureId: capture.id, status: "confirmed", webhookConfirmed });
          return;
        }
      }
      const customer = state.customers.find((item) => offer ? item.id === offer.customerId : item.email.trim().toLowerCase() === row.customer.email.trim().toLowerCase());
      const customerId = customer?.id ?? `customer-${row.id}`;
      if (!customer) state.customers.push({ id: customerId, ...row.customer, prefs: checkoutPreferences(row.availability) });
      else if (row.availability) customer.prefs = { ...customer.prefs, ...checkoutPreferences(row.availability) };
      state.bookings.push({ id: row.id, customerId, sessionId: row.sessionId, amount: row.amount, status: "confirmed",
        bookedAt: new Date().toISOString(),
        payment: { orderId: row.orderId!, captureId: capture.id, simulated: false } });
      repository.saveState(row.workspaceId, state);
      if (offer) repository.saveWaitlistOffer({ ...offer, status: "claimed", bookingId: row.id, respondedAt: new Date().toISOString() });
    }
    repository.appendLedger({ workspaceId: row.workspaceId, bookingId: row.id, kind: "capture", amount: row.amount,
      paypalId: capture.id, captureId: capture.id, requestId: `checkout:${row.id}`, status: "COMPLETED", debugId: order.debugId });
    repository.saveCheckout({ ...row, captureId: capture.id, status: "confirmed", webhookConfirmed });
  };
  if (insideTransaction) persist(); else repository.transaction(persist);
  return receipt(row.workspaceId, row.orderId!, repository);
}

export function receipt(workspaceId: string, orderId: string, repository = getRepository()) {
  const row = repository.checkoutByOrder(workspaceId, orderId);
  if (!row) throw new StoreError(404, "Checkout not found");
  return checkoutReceipt(row, repository);
}
function checkoutReceipt(row: CheckoutReservation, repository: Repository) {
  const { state } = repository.requireWorkspace(row.workspaceId);
  const booking = state.bookings.find((item) => item.id === row.id);
  const session = booking && state.sessions.find((item) => item.id === booking.sessionId);
  const current = booking ? { class: session?.title ?? row.session.title, start: session?.start ?? row.session.start,
    end: session?.end ?? row.session.end, status: booking.status,
    changed: booking.status !== "confirmed" || booking.sessionId !== row.sessionId || !!session &&
      (session.title !== row.session.title || session.start !== row.session.start || session.end !== row.session.end) } : undefined;
  return { orderId: row.orderId, ...(row.paidWith ? { paidWith: row.paidWith } : {}), bookingId: row.id, status: row.status, class: row.session.title, start: row.session.start, end: row.session.end,
    amount: row.amount, currency: row.currency, captureId: row.captureId, webhookConfigured: row.paidWith !== "credit" && Boolean(process.env.PAYPAL_WEBHOOK_ID),
    webhookConfirmed: Boolean(row.webhookConfirmed), current,
    ...(row.waitlistOfferId && repository.listWaitlistOffers(row.workspaceId).some((offer) => offer.id === row.waitlistOfferId && ["expired", "withdrawn"].includes(offer.status) && offer.bookingId === row.id) ? { spotTaken: true } : {}) };
}
export type Receipt = ReturnType<typeof receipt>;

const hasNoCaptures = (order: PayPalOrder) => !order.purchase_units?.some((unit) => unit.payments?.captures?.length);
const neverApproved = (order: PayPalOrder) => ["CREATED", "SAVED", "PAYER_ACTION_REQUIRED"].includes(order.status) && hasNoCaptures(order);
/** Webhooks confirm payments without the workspace lock, so leaving "capturing" must re-check the stored row. */
function leaveCapturing(row: CheckoutReservation, status: "pending" | "failed", repository: Repository): boolean {
  return repository.transaction(() => {
    const current = repository.checkoutByOrder(row.workspaceId, row.orderId!);
    if (current?.status !== "capturing") return false;
    repository.saveCheckout({ ...current, status });
    return true;
  });
}
const settled = (workspaceId: string, orderId: string, repository: Repository) =>
  repository.checkoutByOrder(workspaceId, orderId)?.status === "confirmed" ? receipt(workspaceId, orderId, repository) : undefined;

export async function captureCheckout(workspaceId: string, orderId: string, repository = getRepository()): Promise<Receipt> {
  return withWorkspaceLock(repository, workspaceId, async (owner) => {
    let row = repository.checkoutByOrder(workspaceId, orderId);
    if (!row) throw new StoreError(404, "Checkout not found");
    if (row.status === "confirmed") return receipt(workspaceId, orderId, repository);
    if (row.status === "failed" || (row.status === "pending" && row.expiresAt <= Date.now())) {
      repository.saveCheckout({ ...row, status: "failed" });
      throw new StoreError(410, "Your seat hold expired. Start checkout again.", "RESTART_CHECKOUT");
    }
    if (row.status === "capturing") {
      // Crash/timeout recovery must inspect the existing order before attempting another capture.
      const existing = await getOrder(orderId);
      if (existing.status === "COMPLETED") return confirmOrder(row, existing, repository);
      // A CREATED snapshot cannot rule out an earlier capture request that is still completing; only VOIDED is final.
      if (existing.status === "VOIDED" && hasNoCaptures(existing)) {
        if (!leaveCapturing(row, "failed", repository)) { const done = settled(workspaceId, orderId, repository); if (done) return done; }
        throw new StoreError(410, "This payment was voided. Start checkout again.", "RESTART_CHECKOUT");
      }
      if (row.expiresAt <= Date.now()) throw new StoreError(409, "Your payment is being reconciled. Check its status before starting again.", "CHECK_PAYMENT_STATUS");
    }
    const current = row, firstAttempt = row.status === "pending";
    if (repository.listCheckout(workspaceId).some((other) => other.id !== current.id && other.status === "capturing" &&
      other.sessionId === current.sessionId && other.customer.email.toLowerCase() === current.customer.email.toLowerCase())) {
      throw new StoreError(409, "Your payment is being reconciled. Check its status before starting again.", "CHECK_PAYMENT_STATUS");
    }
    const { state } = repository.requireReadyWorkspace(workspaceId);
    const session = state.sessions.find((item) => item.id === row!.sessionId);
    if (row.status === "pending" && pausedSessionIds(workspaceId, repository).has(row.sessionId)) throw new StoreError(409, BOOKING_PAUSED_MESSAGE, "BOOKING_PAUSED");
    if (!session || !sessionAvailable(state, session) || session.start !== row.session.start || session.end !== row.session.end
      || session.roomId !== row.session.roomId || session.instructorId !== row.session.instructorId
      || !seatsLeft(state, session, repository.listCheckout(workspaceId), row.id, repository.listWaitlistOffers(workspaceId), row.waitlistOfferId)) {
      if (row.status === "capturing") throw new StoreError(409, "Your payment is being reconciled. Check its status before starting again.", "CHECK_PAYMENT_STATUS");
      repository.saveCheckout({ ...row, status: "failed" });
      if (row.waitlistOfferId) {
        const offer = repository.listWaitlistOffers(workspaceId).find((item) => item.id === row!.waitlistOfferId);
        if (offer) repository.saveWaitlistOffer({ ...offer, status: offer.status === "withdrawn" ? "withdrawn" : "expired" });
        throw new StoreError(409, "Sorry, this spot was just taken.", "RESTART_CHECKOUT");
      }
      throw new StoreError(409, "This class changed during checkout. Please choose a class again.", "RESTART_CHECKOUT");
    }
    row = { ...row, status: "capturing" };
    repository.saveCheckout(row);
    try {
      const order = await captureOrder(orderId, `capture:${row.id}`);
      repository.renewLock(workspaceId, owner);
      return confirmOrder(row, order, repository);
    } catch (error) {
      if (repository.checkoutByOrder(workspaceId, orderId)?.status === "confirmed") return receipt(workspaceId, orderId, repository);
      if (error instanceof PayPalError && (error.issues.includes("INSTRUMENT_DECLINED") || error.name === "INSTRUMENT_DECLINED")) {
        if (!leaveCapturing(row, "failed", repository)) { const done = settled(workspaceId, orderId, repository); if (done) return done; }
        throw new StoreError(422, "Payment declined. Choose another payment method and restart checkout.", "INSTRUMENT_DECLINED");
      }
      // Reconcile a lost response or ORDER_ALREADY_CAPTURED with the real SDK's order read.
      let existing: PayPalOrder | undefined;
      try {
        existing = await getOrder(orderId);
        if (existing.status === "COMPLETED") return confirmOrder(row, existing, repository);
        // An empty snapshot cannot rule out a capture that is still completing upstream.
        if (existing.status === "VOIDED" && hasNoCaptures(existing)) leaveCapturing(row, "failed", repository);
      } catch { /* Unknown money outcome: retain the hold; retry capture reconciles it. */ }
      // PayPal explicitly rejected the only capture attempt for an order the buyer never approved: no money can move.
      const rejection = error instanceof PayPalError ? ["ORDER_NOT_APPROVED", "PAYER_ACTION_REQUIRED"].find((issue) => error.issues.includes(issue) || error.name === issue) : undefined;
      if (firstAttempt && rejection && existing && neverApproved(existing)) {
        if (!leaveCapturing(row, row.expiresAt > Date.now() ? "pending" : "failed", repository)) { const done = settled(workspaceId, orderId, repository); if (done) return done; }
        else throw new StoreError(422, "PayPal hasn't approved this payment yet. Approve it in PayPal or choose another method.", rejection);
      }
      throw error;
    }
  });
}

export async function cancelCheckout(workspaceId: string, orderId: string, repository = getRepository()) {
  return withWorkspaceLock(repository, workspaceId, async () => {
    const row = repository.checkoutByOrder(workspaceId, orderId);
    if (row?.status === "capturing") {
      const order = await getOrder(orderId).catch(() => undefined);
      const done = settled(workspaceId, orderId, repository);
      if (done) return { cancelled: false, receipt: done };
      if (order?.status === "COMPLETED") return { cancelled: false, receipt: confirmOrder(row, order, repository) };
      if (order?.status === "VOIDED" && hasNoCaptures(order) && leaveCapturing(row, "failed", repository)) return { cancelled: true };
      throw new StoreError(409, "Your payment is being reconciled. Check its status before starting again.", "CHECK_PAYMENT_STATUS");
    }
    if (row?.status === "confirmed") return { cancelled: false, receipt: receipt(workspaceId, orderId, repository) };
    if (row?.status === "pending") repository.saveCheckout({ ...row, status: "failed" });
    return { cancelled: row?.status === "pending" };
  });
}
