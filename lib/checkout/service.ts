import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Session, State } from "../domain/types";
import { overlaps, toCents } from "../domain/time";
import { activeConstraints } from "../solver/constraints";
import { captureOrder, createBookingOrder, getOrder, PayPalError, type PayPalOrder } from "../paypal/client";
import { getRepository, StoreError, withWorkspaceLock, type CheckoutReservation, type Repository } from "../store";
import { envLimit, limits } from "../api/limits";

export const CheckoutInputSchema = z.strictObject({
  sessionId: z.string().min(1).max(100),
  customer: z.strictObject({ name: z.string().trim().min(1).max(100), email: z.string().trim().pipe(z.email().max(254)) }),
});
export type CheckoutInput = z.infer<typeof CheckoutInputSchema>;
export const BOOKING_PAUSED_MESSAGE = "Schedule change in progress — booking paused";
export function pausedSessionIds(workspaceId: string, repository = getRepository()): Set<string> {
  return new Set(repository.listPlans(workspaceId).filter((plan) => plan.status === "proposed")
    .flatMap((plan) => plan.sessionChanges.map((change) => change.sessionId)));
}
export function sessionAvailable(state: State, session: Session, paused: ReadonlySet<string> = new Set()): boolean {
  return !paused.has(session.id) && Date.parse(session.start) > Date.now() && !activeConstraints(state).some((constraint) =>
    overlaps(session.start, session.end, constraint.from, constraint.to) && (constraint.kind === "closure" ||
      (constraint.kind === "instructor_unavailable" ? constraint.instructorId === session.instructorId : constraint.roomId === session.roomId)));
}
const holdsSeat = (row: CheckoutReservation) => row.status === "capturing" || (row.status === "pending" && row.expiresAt > Date.now());
export function seatsLeft(state: State, session: Session, reservations: CheckoutReservation[], excluding?: string): number {
  return Math.max(0, session.capacity - state.bookings.filter((booking) => booking.sessionId === session.id && ["confirmed", "moved"].includes(booking.status)).length
    - reservations.filter((row) => row.id !== excluding && row.sessionId === session.id && holdsSeat(row)).length);
}
export function bookingCatalog(workspaceId: string, repository = getRepository()) {
  const { state } = repository.requireReadyWorkspace(workspaceId);
  const reservations = repository.listCheckout(workspaceId);
  const paused = pausedSessionIds(workspaceId, repository);
  return { studio: state.studio, sessions: state.sessions.filter((session) => sessionAvailable(state, session)).sort((a, b) => a.start.localeCompare(b.start)).map((session) => ({
    ...session, bookingPaused: paused.has(session.id), seatsLeft: seatsLeft(state, session, reservations),
    instructor: state.instructors.find((item) => item.id === session.instructorId)?.name ?? "Studio team",
    room: state.rooms.find((item) => item.id === session.roomId)?.name ?? "Studio",
  })) };
}

export async function createOrder(workspaceId: string, input: CheckoutInput, requestId: string, repository = getRepository()) {
  input = CheckoutInputSchema.parse(input);
  return withWorkspaceLock(repository, workspaceId, async (owner) => {
    let row = repository.listCheckout(workspaceId).find((item) => item.requestId === requestId || item.requestAliases?.includes(requestId));
    if (row && (row.sessionId !== input.sessionId || JSON.stringify(row.customer) !== JSON.stringify(input.customer))) throw new StoreError(409, "This checkout key belongs to another booking");
    if (row?.status === "failed" || (row?.status === "pending" && row.expiresAt <= Date.now())) throw new StoreError(410, "Your seat hold expired. Start checkout again.", "RESTART_CHECKOUT");
    if (row?.orderId) return { orderId: row.orderId };
    if (pausedSessionIds(workspaceId, repository).has(input.sessionId)) throw new StoreError(409, BOOKING_PAUSED_MESSAGE, "BOOKING_PAUSED");
    if (!row) {
      const unresolved = repository.listCheckout(workspaceId).find((item) => item.status === "capturing" &&
        item.sessionId === input.sessionId && item.customer.email.toLowerCase() === input.customer.email.toLowerCase());
      if (unresolved?.orderId) {
        if (JSON.stringify(unresolved.customer) !== JSON.stringify(input.customer) || (unresolved.requestAliases?.length ?? 0) >= 32) {
          throw new StoreError(409, "Your payment is being reconciled. Check its status before starting again.", "CHECK_PAYMENT_STATUS");
        }
        // Remember every accepted key before responding, even if a webhook settles the order next.
        repository.saveCheckout({ ...unresolved, requestAliases: [...(unresolved.requestAliases ?? []), requestId] });
        return { orderId: unresolved.orderId };
      }
      row = repository.transaction(() => {
        const { state } = repository.requireReadyWorkspace(workspaceId);
        const session = state.sessions.find((item) => item.id === input.sessionId);
        if (!session || !sessionAvailable(state, session)) throw new StoreError(409, "This class is no longer available");
        if (!seatsLeft(state, session, repository.listCheckout(workspaceId))) throw new StoreError(409, "This class is full. Please choose another class.");
        if (toCents(session.price) <= 0) throw new StoreError(409, "This class cannot be purchased");
        limits.take([{ key: "captures", max: envLimit("MAX_REAL_CAPTURES_PER_HOUR", 1500), ms: 3_600_000 }]);
        const reservation: CheckoutReservation = { id: randomUUID(), workspaceId, requestId, sessionId: session.id,
          customer: input.customer, amount: session.price, currency: state.studio.currency, session,
          expiresAt: Date.now() + 10 * 60_000, status: "pending" };
        repository.saveCheckout(reservation);
        return reservation;
      });
    }
    const reservation = row;
    try {
      const { state } = repository.requireReadyWorkspace(workspaceId);
      const localTime = new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(reservation.session.start));
      const order = await createBookingOrder(reservation.amount, { workspaceId, bookingId: reservation.id, requestId: reservation.id }, `${reservation.session.title} · ${localTime}`);
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

function validateCapture(row: CheckoutReservation, order: PayPalOrder) {
  const unit = order.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  if (order.id !== row.orderId || order.status !== "COMPLETED" || order.purchase_units?.length !== 1 || !capture?.id || capture.status !== "COMPLETED"
    || unit?.payments?.captures?.length !== 1 || unit.custom_id !== `${row.workspaceId}:${row.id}` || unit.reference_id !== row.id
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
      const customerId = `customer-${row.id}`;
      state.customers.push({ id: customerId, ...row.customer, prefs: { acceptsSubstitute: true,
        windows: Array.from({ length: 7 }, (_, weekday) => ({ weekday, from: "00:00", to: "23:59" })) } });
      state.bookings.push({ id: row.id, customerId, sessionId: row.sessionId, amount: row.amount, status: "confirmed",
        bookedAt: new Date().toISOString(),
        payment: { orderId: row.orderId!, captureId: capture.id, simulated: false } });
      repository.saveState(row.workspaceId, state);
    }
    repository.appendLedger({ workspaceId: row.workspaceId, bookingId: row.id, kind: "capture", amount: row.amount,
      paypalId: capture.id, captureId: capture.id, requestId: `checkout:${row.id}`, status: "COMPLETED", debugId: order.debugId });
    repository.saveCheckout({ ...row, captureId: capture.id, status: "confirmed", webhookConfirmed });
  };
  if (insideTransaction) persist(); else repository.transaction(persist);
  return receipt(row.workspaceId, row.orderId!, repository);
}

export function receipt(workspaceId: string, orderId: string, repository = getRepository()) {
  repository.requireWorkspace(workspaceId);
  const row = repository.checkoutByOrder(workspaceId, orderId);
  if (!row) throw new StoreError(404, "Checkout not found");
  return { orderId, bookingId: row.id, status: row.status, class: row.session.title, start: row.session.start, end: row.session.end,
    amount: row.amount, currency: row.currency, captureId: row.captureId, webhookConfigured: Boolean(process.env.PAYPAL_WEBHOOK_ID),
    webhookConfirmed: Boolean(row.webhookConfirmed) };
}
export type Receipt = ReturnType<typeof receipt>;

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
      if (existing.status === "VOIDED" && !existing.purchase_units?.some((unit) => unit.payments?.captures?.length)) {
        repository.saveCheckout({ ...row, status: "failed" });
        throw new StoreError(410, "This payment was voided. Start checkout again.", "RESTART_CHECKOUT");
      }
      if (row.expiresAt <= Date.now()) throw new StoreError(409, "Your payment is being reconciled. Check its status before starting again.", "CHECK_PAYMENT_STATUS");
    }
    const current = row;
    if (repository.listCheckout(workspaceId).some((other) => other.id !== current.id && other.status === "capturing" &&
      other.sessionId === current.sessionId && other.customer.email.toLowerCase() === current.customer.email.toLowerCase())) {
      throw new StoreError(409, "Your payment is being reconciled. Check its status before starting again.", "CHECK_PAYMENT_STATUS");
    }
    const { state } = repository.requireReadyWorkspace(workspaceId);
    const session = state.sessions.find((item) => item.id === row!.sessionId);
    if (row.status === "pending" && pausedSessionIds(workspaceId, repository).has(row.sessionId)) throw new StoreError(409, BOOKING_PAUSED_MESSAGE, "BOOKING_PAUSED");
    if (!session || !sessionAvailable(state, session) || session.start !== row.session.start || session.end !== row.session.end
      || session.roomId !== row.session.roomId || session.instructorId !== row.session.instructorId
      || !seatsLeft(state, session, repository.listCheckout(workspaceId), row.id)) {
      if (row.status === "capturing") throw new StoreError(409, "Your payment is being reconciled. Check its status before starting again.", "CHECK_PAYMENT_STATUS");
      repository.saveCheckout({ ...row, status: "failed" });
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
        repository.saveCheckout({ ...row, status: "failed" });
        throw new StoreError(422, "Payment declined. Choose another payment method and restart checkout.", "INSTRUMENT_DECLINED");
      }
      // Reconcile a lost response or ORDER_ALREADY_CAPTURED with the real SDK's order read.
      try {
        const existing = await getOrder(orderId);
        if (existing.status === "COMPLETED") return confirmOrder(row, existing, repository);
        // An empty snapshot cannot rule out a capture that is still completing upstream.
        if (existing.status === "VOIDED" && !existing.purchase_units?.some((unit) => unit.payments?.captures?.length)) repository.saveCheckout({ ...row, status: "failed" });
      } catch { /* Unknown money outcome: retain the hold; retry capture reconciles it. */ }
      throw error;
    }
  });
}

export async function cancelCheckout(workspaceId: string, orderId: string, repository = getRepository()) {
  return withWorkspaceLock(repository, workspaceId, () => {
    const row = repository.checkoutByOrder(workspaceId, orderId);
    if (row?.status === "capturing") throw new StoreError(409, "Your payment is being reconciled. Check its status before starting again.", "CHECK_PAYMENT_STATUS");
    if (row?.status === "confirmed") return { cancelled: false, receipt: receipt(workspaceId, orderId, repository) };
    if (row?.status === "pending") repository.saveCheckout({ ...row, status: "failed" });
    return { cancelled: row?.status === "pending" };
  });
}
