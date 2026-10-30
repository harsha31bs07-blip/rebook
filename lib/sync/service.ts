import { randomUUID } from "node:crypto";
import { BookingSchema, CustomerSchema, StateSchema, WaitlistEntrySchema } from "../domain/schemas";
import type { State } from "../domain/types";
import { packChangeId, packReturns } from "../domain/pack-balances";
import { seatsLeft } from "../checkout/service";
import { checkoutHoldsSeat, heldOffers } from "../waitlist/capacity";
import { fillFreedSeats } from "../waitlist/service";
import { getRepository, StoreError, withWorkspaceLock, type Repository, type SyncEventResult } from "../store";
import { allChanges, pendingChanges } from "./feed";
import { EventsSchema, type InboundEvent } from "./schemas";

function updateAcknowledgedPacks(workspaceId: string, state: State, repository: Repository): void {
  const acks = repository.syncAcks(workspaceId), returned = packReturns(repository.listLedger(workspaceId));
  for (const baseline of state.syncPackBalances ?? []) baseline.acknowledgedBookingIds = returned.filter((row) => acks.has(packChangeId(row))
    && state.bookings.some((booking) => booking.id === row.bookingId && booking.customerId === baseline.customerId && booking.entitlement?.kind === "pack")).map((row) => row.bookingId);
}
export async function acknowledge(workspaceId: string, ids?: string[], repository = getRepository()) {
  return withWorkspaceLock(repository, workspaceId, () => repository.transaction(() => {
    const known = new Set(allChanges(workspaceId, repository).map((row) => row.id));
    const acknowledged = repository.acknowledgeSync(workspaceId, [...new Set(ids ?? known)].filter((id) => known.has(id)));
    const { state } = repository.requireWorkspace(workspaceId);
    if (state.syncPackBalances?.length) {
      updateAcknowledgedPacks(workspaceId, state, repository); repository.saveState(workspaceId, state);
    }
    return { acknowledged, pending: pendingChanges(workspaceId, repository).length };
  }));
}
function resolveCustomer(state: State, reference: { name: string; email?: string }, create: boolean) {
  const email = reference.email?.toLowerCase();
  const matches = email ? state.customers.filter((row) => row.email.toLowerCase() === email) : [];
  const names = matches.length ? matches : state.customers.filter((row) => row.name === reference.name);
  if (names.length > 1) throw new StoreError(409, "Customer reference is ambiguous; use an email");
  if (names[0]) return names[0];
  if (!create) throw new StoreError(404, "Customer not found");
  const id = randomUUID();
  const customer = CustomerSchema.parse({ id, name: reference.name, email: reference.email ?? `${id}@sync.invalid`,
    prefs: { windows: [], acceptsSubstitute: true, availabilityKnown: false } });
  state.customers.push(customer); return customer;
}
function applyEvent(workspaceId: string, event: InboundEvent, repository: Repository): void {
  const { state } = repository.requireReadyWorkspace(workspaceId);
  if (repository.listPlans(workspaceId).some((plan) => plan.status === "proposed")) throw new StoreError(409, "A recovery preview is open; approve or discard it first.");
  if (event.type === "pack.balance") {
    const customer = resolveCustomer(state, event.customer, false);
    state.syncPackBalances = (state.syncPackBalances ?? []).filter((row) => row.customerId !== customer.id);
    state.syncPackBalances.push({ customerId: customer.id, visitsLeft: event.visitsLeft, expires: event.expires, acknowledgedBookingIds: [] });
    updateAcknowledgedPacks(workspaceId, state, repository);
    for (const booking of state.bookings) if (booking.customerId === customer.id && booking.entitlement?.kind === "pack" && event.expires) booking.entitlement.expires = event.expires;
    repository.saveState(workspaceId, StateSchema.parse(state)); return;
  }
  const reference = event.session;
  const sessions = state.sessions.filter((row) => "id" in reference ? row.id === reference.id
    : row.title.toLowerCase() === reference.title.toLowerCase() && Date.parse(row.start) === Date.parse(reference.start));
  if (!sessions.length) throw new StoreError(404, "Session not found or cancelled");
  if (sessions.length !== 1) throw new StoreError(409, "Session reference is ambiguous; use its id");
  const session = sessions[0];
  if (Date.parse(session.start) <= Date.now()) throw new StoreError(409, "Class has already started");
  const reservations = repository.listCheckout(workspaceId), offers = repository.listWaitlistOffers(workspaceId);
  if (event.type === "session.capacity") {
    const room = state.rooms.find((row) => row.id === session.roomId);
    const occupied = state.bookings.filter((row) => row.sessionId === session.id && ["confirmed", "moved"].includes(row.status)).length
      + reservations.filter((row) => row.sessionId === session.id && checkoutHoldsSeat(row)).length + heldOffers(session.id, offers, reservations);
    if (!room || event.capacity > room.capacity) throw new StoreError(409, "Capacity exceeds room capacity");
    if (event.capacity < occupied) throw new StoreError(409, "Capacity is below booked and held seats");
    session.capacity = event.capacity;
  } else {
    const customer = resolveCustomer(state, event.customer, event.type === "booking.created" || event.type === "waitlist.joined");
    const active = state.bookings.find((row) => row.sessionId === session.id && row.customerId === customer.id && ["confirmed", "moved"].includes(row.status));
    if (event.type === "booking.created") {
      if (active) throw new StoreError(409, "Customer is already booked in this class");
      if (!seatsLeft(state, session, reservations, undefined, offers)) throw new StoreError(409, "Class is full");
      if (event.entitlement && event.amount && event.amount !== "0.00") throw new StoreError(400, "Entitlement bookings must have zero amount");
      state.bookings.push(BookingSchema.parse({ id: randomUUID(), sessionId: session.id, customerId: customer.id,
        status: "confirmed", bookedAt: new Date().toISOString(), amount: event.entitlement ? "0.00" : event.amount ?? session.price, entitlement: event.entitlement }));
    } else if (event.type === "booking.cancelled") {
      if (!active) throw new StoreError(404, "Active booking not found");
      active.status = "cancelled";
    } else if (event.type === "waitlist.joined") {
      if (active) throw new StoreError(409, "Customer is already booked in this class");
      state.waitlist ??= [];
      if (!state.waitlist.some((row) => row.sessionId === session.id && row.customerId === customer.id)) state.waitlist.push(WaitlistEntrySchema.parse({
        id: randomUUID(), sessionId: session.id, customerId: customer.id, joinedAt: new Date().toISOString(), entitlement: event.entitlement,
      }));
    } else {
      state.waitlist = (state.waitlist ?? []).filter((row) => row.sessionId !== session.id || row.customerId !== customer.id);
      for (const offer of offers) if (offer.sessionId === session.id && offer.customerId === customer.id && offer.status === "offered") {
        if (reservations.some((row) => row.waitlistOfferId === offer.id && row.status === "capturing")) throw new StoreError(409, "A waitlist payment is being reconciled; retry later");
        repository.saveWaitlistOffer({ ...offer, status: "withdrawn" });
        for (const row of reservations) if (row.waitlistOfferId === offer.id && row.status === "pending") repository.saveCheckout({ ...row, status: "failed" });
      }
    }
  }
  repository.saveState(workspaceId, StateSchema.parse(state));
  fillFreedSeats(workspaceId, repository);
}
export async function receiveEvents(workspaceId: string, input: { events: InboundEvent[] }, repository = getRepository()) {
  input = EventsSchema.parse(input);
  return withWorkspaceLock(repository, workspaceId, () => {
    const results: (Omit<SyncEventResult, "status"> & { status: SyncEventResult["status"] | "duplicate" })[] = [];
    for (const event of input.events) {
      // Rejections are shown to the owner but not final: a retry with the same id is evaluated again.
      const previous = repository.listSyncEvents(workspaceId).find((row) => row.eventId === event.eventId && row.result.status === "applied");
      if (previous) { results.push({ ...previous.result, status: "duplicate" }); continue; }
      let result: SyncEventResult;
      try {
        repository.transaction(() => {
          applyEvent(workspaceId, event, repository);
          result = { eventId: event.eventId, status: "applied" };
          repository.saveSyncEvent(workspaceId, event.type, result);
        });
        result = { eventId: event.eventId, status: "applied" };
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
        result = { eventId: event.eventId, status: "rejected", message: error.message };
        repository.saveSyncEvent(workspaceId, event.type, result);
      }
      results.push(result);
    }
    return { results };
  });
}
export function ownerSync(workspaceId: string, repository = getRepository()) {
  const changes = pendingChanges(workspaceId, repository);
  return { key: repository.syncKey(workspaceId), pending: changes.length, recentChanges: changes.slice(-10).reverse(), recentEvents: repository.listSyncEvents(workspaceId).slice(-10).reverse() };
}
