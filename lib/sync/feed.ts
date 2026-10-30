import type { Booking, Customer, Session, State } from "../domain/types";
import { packChangeId, packReturnBalance, packReturns } from "../domain/pack-balances";
import { getRepository, type Repository } from "../store";

export type SyncSession = { id: string; title: string; start: string; end: string; instructor: string; room: string };
type SyncCustomer = { id: string; name: string; email?: string };
type ChangeBase = { id: string; occurredAt: string };
export type SyncChange = ChangeBase & (
  { type: "session.moved"; session: SyncSession; before: SyncSession; after: SyncSession } |
  { type: "session.cancelled"; session: SyncSession } |
  { type: "booking.moved"; bookingId: string; customer: SyncCustomer; from: SyncSession; to: SyncSession } |
  { type: "booking.cancelled"; bookingId: string; customer: SyncCustomer; session: SyncSession; reason: "refunded" | "credited" | "cancelled"; amount?: string } |
  { type: "pack.visit_returned"; bookingId: string; customer: SyncCustomer; visitsLeftAfter?: number } |
  { type: "booking.created"; bookingId: string; source: "waitlist" | "checkout"; session: SyncSession; customer: SyncCustomer; amount: string; entitlement?: Booking["entitlement"] }
);
const person = (customer: Customer): SyncCustomer => ({ id: customer.id, name: customer.name,
  ...(customer.email.endsWith("@sync.invalid") ? {} : { email: customer.email }) });
function sessionView(session: Session, state: State): SyncSession {
  return { id: session.id, title: session.title, start: session.start, end: session.end,
    instructor: state.instructors.find((row) => row.id === session.instructorId)?.name ?? session.instructorId,
    room: state.rooms.find((row) => row.id === session.roomId)?.name ?? session.roomId };
}

/** Durable Rebook operations are the outbox; acknowledgements never erase their history. */
export function allChanges(workspaceId: string, repository: Repository = getRepository()): SyncChange[] {
  const { state } = repository.requireWorkspace(workspaceId), plans = repository.listPlans(workspaceId);
  const links = repository.listCustomerLinks(workspaceId), ledger = repository.listLedger(workspaceId);
  const sessions = new Map(plans.flatMap((plan) => plan.basis?.sessions ?? []).map((row) => [row.id, row]));
  for (const row of state.sessions) sessions.set(row.id, row);
  const changes: SyncChange[] = [];
  for (const plan of plans.filter((row) => row.status !== "proposed" && row.basis)) {
    const basis = plan.basis!, occurredAt = links.find((link) => link.planId === plan.id)?.createdAt ?? plan.createdAt;
    for (const change of plan.sessionChanges) {
      const original = basis.sessions.find((row) => row.id === change.sessionId);
      if (!original) continue;
      const before = sessionView({ ...original, ...change.before }, basis);
      const id = `plan:${plan.id}:session:${change.sessionId}`;
      if (!change.after) changes.push({ id, occurredAt, type: "session.cancelled", session: before });
      else {
        const after = sessionView({ ...original, ...change.after }, basis);
        changes.push({ id, occurredAt, type: "session.moved", session: after, before, after });
      }
    }
    for (const action of plan.bookingActions.filter((row) => row.action === "move")) {
      const booking = basis.bookings.find((row) => row.id === action.bookingId), customer = basis.customers.find((row) => row.id === action.customerId);
      const change = plan.sessionChanges.find((row) => row.sessionId === booking?.sessionId);
      const original = basis.sessions.find((row) => row.id === booking?.sessionId);
      if (!booking || !customer || !original || !change?.after) continue;
      changes.push({ id: `plan:${plan.id}:booking:${booking.id}`, occurredAt, type: "booking.moved", bookingId: booking.id, customer: person(customer),
        from: sessionView({ ...original, ...change.before }, basis), to: sessionView({ ...original, ...change.after }, basis) });
    }
  }
  for (const link of links.filter((row) => row.kind === "choice" && row.reply)) {
    const reply = link.reply!, booking = state.bookings.find((row) => row.id === link.bookingId);
    const customer = state.customers.find((row) => row.id === booking?.customerId);
    if (!booking || !customer) continue;
    const base = { id: `choice:${link.id}:${reply.at}`, occurredAt: reply.at, bookingId: booking.id, customer: person(customer) };
    const target = sessions.get(reply.sessionId ?? "");
    if (reply.action === "move" && target) changes.push({ ...base, type: "booking.moved", from: sessionView(link.after ?? link.before, state), to: sessionView(target, state) });
    if (reply.action === "credit") changes.push({ ...base, type: "booking.cancelled", session: sessionView(link.after ?? link.before, state), reason: "credited", amount: reply.amount });
  }
  for (const event of repository.latestMoneyEvents(workspaceId).filter((row) => row.kind === "refund" && !row.partial &&
    ["COMPLETED", "PENDING", "SIMULATED", "VISIT_RETURNED", "CREDIT_RESTORED", "NO_REFUND"].includes(row.status))) {
    const booking = state.bookings.find((row) => row.id === event.bookingId), customer = state.customers.find((row) => row.id === booking?.customerId);
    const link = links.find((row) => row.bookingId === event.bookingId && (row.reply?.requestId === event.requestId || event.requestId === `${row.planId}:${row.bookingId}`));
    if (!link && !plans.some((plan) => plan.status !== "proposed" && event.requestId === `${plan.id}:${event.bookingId}`)) continue;
    const session = link?.after ?? link?.before ?? sessions.get(booking?.sessionId ?? "");
    if (!booking || !customer || !session) continue;
    changes.push({ id: `refund:${event.requestId}`, occurredAt: event.firstAttemptAt ?? event.createdAt, type: "booking.cancelled", bookingId: booking.id, customer: person(customer),
      session: sessionView(session, state), reason: booking.entitlement ? "cancelled" : event.status === "CREDIT_RESTORED" ? "credited" : "refunded",
      ...(!booking.entitlement ? { amount: event.amount } : {}) });
  }
  for (const event of packReturns(ledger)) {
    const booking = state.bookings.find((row) => row.id === event.bookingId), customer = state.customers.find((row) => row.id === booking?.customerId);
    if (!booking || !customer || booking.entitlement?.kind !== "pack") continue;
    changes.push({ id: packChangeId(event), occurredAt: event.createdAt, type: "pack.visit_returned", bookingId: booking.id, customer: person(customer), visitsLeftAfter: packReturnBalance(state, ledger, booking)?.after });
  }
  const offers = repository.listWaitlistOffers(workspaceId), checkouts = repository.listCheckout(workspaceId);
  const created = [...offers.filter((row) => row.status === "claimed" && row.bookingId).map((row) => ({ id: row.bookingId!, sessionId: row.sessionId, at: row.respondedAt ?? row.createdAt, source: "waitlist" as const })),
    ...checkouts.filter((row) => row.status === "confirmed" && !row.waitlistOfferId).map((row) => ({ id: row.id, sessionId: row.sessionId, at: state.bookings.find((booking) => booking.id === row.id)?.bookedAt ?? new Date(row.expiresAt).toISOString(), source: "checkout" as const }))];
  for (const row of created) {
    const snapshot = plans.find((plan) => plan.basis?.bookings.some((booking) => booking.id === row.id))?.basis;
    const booking = snapshot?.bookings.find((booking) => booking.id === row.id) ?? state.bookings.find((booking) => booking.id === row.id);
    const customer = state.customers.find((item) => item.id === booking?.customerId);
    const checkout = checkouts.find((item) => item.id === row.id);
    const session = checkout?.session ?? snapshot?.sessions.find((session) => session.id === row.sessionId) ?? sessions.get(row.sessionId);
    if (booking && customer && session) changes.push({ id: `created:${row.id}`, occurredAt: row.at, type: "booking.created", bookingId: row.id,
      source: row.source, session: sessionView(session, state), customer: person(customer), amount: checkout?.amount ?? booking.amount, entitlement: booking.entitlement });
  }
  return changes.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id));
}
export function pendingChanges(workspaceId: string, repository: Repository = getRepository()): SyncChange[] {
  const acks = repository.syncAcks(workspaceId);
  return allChanges(workspaceId, repository).filter((change) => !acks.has(change.id));
}
export function changeFeed(workspaceId: string, repository: Repository = getRepository()) {
  const pending = pendingChanges(workspaceId, repository);
  return { changes: pending.slice(0, 200), pending: pending.length };
}
