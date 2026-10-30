import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getRepository, StoreError, withWorkspaceLock, type Repository } from "../store";
import { bookingCatalog, pausedSessionIds, seatsLeft, sessionAvailable, WaitlistTokenSchema } from "../checkout/service";
import { checkoutHoldsSeat, offerHoldsSeat } from "./capacity";
import { deliverableAddress } from "../choices/email-content";
import type { OutboxCustomer } from "../choices/outbox";
import { packBalance } from "../domain/pack-balances";
import { localParts } from "../domain/time";
import type { Session, State } from "../domain/types";
import type { LedgerEvent } from "../store";

export { WaitlistTokenSchema };
export const OfferActionSchema = z.strictObject({ action: z.enum(["claim", "decline"]) });
export const SPOT_TAKEN = "Sorry, this spot was just taken.";
function requireOffer(token: string, repository: Repository) {
  const offer = repository.waitlistOfferByToken(WaitlistTokenSchema.parse(token));
  if (!offer) throw new StoreError(404, "This private link is no longer available. The demo may have been reset. Please ask the studio for a new link.");
  repository.requireReadyWorkspace(offer.workspaceId);
  return offer;
}
type Entry = NonNullable<State["waitlist"]>[number];
/** A pack or membership pays for a claimed spot only while it is valid for that class; otherwise the spot is paid at checkout. */
export function claimEntitlement(state: State, ledger: LedgerEvent[], entry: Entry, session: Session): { entitlement?: Entry["entitlement"]; note?: string } {
  const value = entry.entitlement;
  if (!value) return {};
  const expires = value.expires ?? state.syncPackBalances?.find((row) => row.customerId === entry.customerId)?.expires ?? state.bookings.find((booking) =>
    booking.customerId === entry.customerId && booking.entitlement?.name === value.name && booking.entitlement.expires)?.entitlement?.expires;
  if (expires && expires < localParts(session.start, state.studio.timezone).dateKey) return { note: `Your ${value.name} expires before this class, so this spot is paid at checkout.` };
  const balance = value.kind === "pack" ? packBalance(state, ledger, entry.customerId, value.name) : null;
  if (balance !== null && balance <= 0) return { note: `Your ${value.name} has no visits left, so this spot is paid at checkout.` };
  const { visitsLeft: _left, ...rest } = value;
  void _left;
  return { entitlement: rest, ...(balance === null ? {} : { note: `Uses 1 visit from your ${value.name} (${balance - 1} left after this class).` }) };
}
/** Synchronous SQLite transaction also serializes lazy advancement across processes. */
export function fillFreedSeats(workspaceId: string, repository = getRepository()): void {
  repository.transaction(() => {
    const { state } = repository.requireReadyWorkspace(workspaceId);
    if (!state.waitlist?.length) return;
    const reservations = repository.listCheckout(workspaceId), offers = repository.listWaitlistOffers(workspaceId);
    for (const offer of offers) if (offer.status === "offered" && !offerHoldsSeat(offer, reservations)) {
      offer.status = "expired"; repository.saveWaitlistOffer(offer);
    }
    const paused = pausedSessionIds(workspaceId, repository);
    for (const session of state.sessions) {
      if (!sessionAvailable(state, session, paused)) continue;
      const expiresAt = new Date(Math.min(Date.now() + 12 * 3_600_000, Date.parse(session.start) - 3_600_000)).toISOString();
      if (Date.parse(expiresAt) <= Date.now()) continue;
      let free = seatsLeft(state, session, reservations, undefined, offers);
      if (!free) continue;
      const entries = state.waitlist.filter((entry) => entry.sessionId === session.id).toSorted((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt) || a.id.localeCompare(b.id));
      for (const entry of entries) {
        if (!free) break;
        if (!state.customers.some((customer) => customer.id === entry.customerId)
          || offers.some((offer) => (offer.entryId === entry.id && offer.status !== "withdrawn") || (offer.customerId === entry.customerId && offer.sessionId === session.id && offerHoldsSeat(offer, reservations)))
          || state.bookings.some((booking) => booking.sessionId === session.id && booking.customerId === entry.customerId && ["confirmed", "moved"].includes(booking.status))) continue;
        offers.push(repository.createWaitlistOffer({ workspaceId, entryId: entry.id, sessionId: session.id, customerId: entry.customerId, expiresAt }));
        free--;
      }
    }
  });
}
export function withdrawWaitlistOffers(workspaceId: string, sessionIds: ReadonlySet<string>, repository: Repository): void {
  for (const offer of repository.listWaitlistOffers(workspaceId)) if (offer.status === "offered" && sessionIds.has(offer.sessionId)) {
    repository.saveWaitlistOffer({ ...offer, status: "withdrawn" });
    for (const row of repository.listCheckout(workspaceId)) if (row.waitlistOfferId === offer.id && row.status === "pending") repository.saveCheckout({ ...row, status: "failed" });
  }
}
export function waitlistOfferView(token: string, repository = getRepository()) {
  const initial = requireOffer(token, repository);
  return repository.transaction(() => {
    fillFreedSeats(initial.workspaceId, repository);
    const offer = requireOffer(token, repository), { state, bookingId } = repository.requireReadyWorkspace(offer.workspaceId);
    const session = bookingCatalog(offer.workspaceId, repository).sessions.find((item) => item.id === offer.sessionId);
    const entry = state.waitlist?.find((item) => item.id === offer.entryId);
    const customer = state.customers.find((item) => item.id === offer.customerId)!;
    const live = state.sessions.find((item) => item.id === offer.sessionId);
    return { status: offer.status, expiresAt: offer.expiresAt, studio: { name: state.studio.name, timezone: state.studio.timezone },
      session, customer: { name: customer.name, email: customer.email }, bookingId,
      ...(entry && live ? claimEntitlement(state, repository.listLedger(offer.workspaceId), entry, live) : {}), canClaim: offer.status === "offered" && !!session && !session.bookingPaused,
      checkoutPending: repository.listCheckout(offer.workspaceId).some((row) => row.waitlistOfferId === offer.id && checkoutHoldsSeat(row)) };
  });
}
export type WaitlistOfferView = ReturnType<typeof waitlistOfferView>;
export async function respondToWaitlistOffer(token: string, action: "claim" | "decline", repository = getRepository()) {
  const initial = requireOffer(token, repository);
  return withWorkspaceLock(repository, initial.workspaceId, () => {
    const taken = repository.transaction(() => {
      fillFreedSeats(initial.workspaceId, repository);
      const offer = requireOffer(token, repository);
      if (offer.status !== "offered") return false;
      const reservations = repository.listCheckout(offer.workspaceId);
      if (reservations.some((row) => row.waitlistOfferId === offer.id && checkoutHoldsSeat(row))) {
        if (action === "decline") throw new StoreError(409, "Finish or cancel your checkout before declining this spot.");
        return false;
      }
      const at = new Date().toISOString();
      if (action === "decline") {
        repository.saveWaitlistOffer({ ...offer, status: "declined", respondedAt: at });
        fillFreedSeats(offer.workspaceId, repository); return false;
      }
      const { state } = repository.requireReadyWorkspace(offer.workspaceId);
      const session = state.sessions.find((item) => item.id === offer.sessionId);
      if (!session || !sessionAvailable(state, session, pausedSessionIds(offer.workspaceId, repository))) throw new StoreError(409, "This class changed. Please contact the studio.");
      if (!seatsLeft(state, session, reservations, undefined, repository.listWaitlistOffers(offer.workspaceId), offer.id)
        || state.bookings.some((booking) => booking.sessionId === session.id && booking.customerId === offer.customerId && ["confirmed", "moved"].includes(booking.status))) {
        repository.saveWaitlistOffer({ ...offer, status: "expired", respondedAt: at }); return true;
      }
      const entry = state.waitlist?.find((item) => item.id === offer.entryId);
      if (!entry) throw new StoreError(410, "This waitlist entry is no longer available.");
      const { entitlement } = claimEntitlement(state, repository.listLedger(offer.workspaceId), entry, session);
      if (entitlement) {
        const id = randomUUID();
        state.bookings.push({ id, customerId: offer.customerId, sessionId: offer.sessionId, amount: "0.00", entitlement, status: "confirmed", bookedAt: at,
          ...(entitlement.kind === "pack" ? { packVisitUsed: true as const } : {}) });
        repository.saveState(offer.workspaceId, state);
        repository.saveWaitlistOffer({ ...offer, status: "claimed", bookingId: id, respondedAt: at });
      }
      return false;
    });
    if (taken) throw new StoreError(409, SPOT_TAKEN);
    return waitlistOfferView(token, repository);
  });
}
export function ownerWaitlist(workspaceId: string, repository = getRepository()) {
  const { state } = repository.requireWorkspace(workspaceId), offers = repository.listWaitlistOffers(workspaceId);
  return [...new Set((state.waitlist ?? []).map((entry) => entry.sessionId))].map((sessionId) => ({ sessionId,
    title: state.sessions.find((session) => session.id === sessionId)?.title ?? "Cancelled class",
    start: state.sessions.find((session) => session.id === sessionId)?.start,
    waiting: (state.waitlist ?? []).filter((entry) => entry.sessionId === sessionId && !offers.some((offer) => offer.entryId === entry.id && offer.status !== "withdrawn")
      && !state.bookings.some((booking) => booking.sessionId === sessionId && booking.customerId === entry.customerId && ["confirmed", "moved"].includes(booking.status))).length,
    offers: offers.filter((offer) => offer.sessionId === sessionId).map((offer) => ({ id: offer.id, status: offer.status, expiresAt: offer.expiresAt,
      customerName: state.customers.find((customer) => customer.id === offer.customerId)?.name ?? "Customer" })) }));
}
export function waitlistOutbox(workspaceId: string, repository: Repository): OutboxCustomer[] {
  const { state } = repository.requireWorkspace(workspaceId), reservations = repository.listCheckout(workspaceId), deliveries = repository.listDeliveries(workspaceId);
  return repository.listWaitlistOffers(workspaceId).filter((offer) => offerHoldsSeat(offer, reservations)).map((offer) => {
    const customer = state.customers.find((item) => item.id === offer.customerId)!;
    const title = state.sessions.find((item) => item.id === offer.sessionId)?.title ?? "your class";
    const until = new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(offer.expiresAt));
    const delivery = deliveries.find((item) => item.planId === offer.id && item.kind === "message");
    const reminder = deliveries.find((item) => item.planId === offer.id && item.kind === "reminder");
    return { customerId: customer.id, customerName: customer.name, planId: offer.id, waitlistOffer: true,
      emailDeliverable: deliverableAddress(customer.email, reservations.map((row) => row.id), reservations),
      delivery: delivery ? { status: delivery.status, updatedAt: delivery.updatedAt } : undefined,
      reminderDelivery: reminder ? { status: reminder.status, updatedAt: reminder.updatedAt } : undefined,
      changes: [{ bookingId: offer.id, kind: "waitlist", subject: `A spot opened in ${title}`,
        body: `Hi ${customer.name}, a spot opened in ${title} at ${state.studio.name}. We've held it for you until ${until}. Claim it or let the next person know with your private link.`,
        path: `/s/${repository.waitlistToken(offer)}`, expiresAt: Date.parse(offer.expiresAt), sentAt: offer.sentAt }] };
  });
}
/** A customer (or their AI agent) joins a full class's waitlist; the same email joining twice keeps its place. */
export async function joinWaitlist(workspaceId: string, sessionId: string, person: { name: string; email: string }, repository = getRepository()) {
  return withWorkspaceLock(repository, workspaceId, () => {
    const { state } = repository.requireReadyWorkspace(workspaceId);
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session || !sessionAvailable(state, session, pausedSessionIds(workspaceId, repository)) || Date.parse(session.start) <= Date.now()) throw new StoreError(409, "This class is not taking bookings.");
    if (seatsLeft(state, session, repository.listCheckout(workspaceId), undefined, repository.listWaitlistOffers(workspaceId)) > 0) throw new StoreError(409, "This class still has free spots; book it instead.");
    const email = person.email.toLowerCase();
    let customer = state.customers.find((item) => item.email.toLowerCase() === email);
    if (customer && state.bookings.some((booking) => booking.sessionId === sessionId && booking.customerId === customer!.id && ["confirmed", "moved"].includes(booking.status))) throw new StoreError(409, "You are already booked in this class.");
    if (!customer) {
      customer = { id: randomUUID(), name: person.name, email: person.email, prefs: { acceptsSubstitute: true, availabilityKnown: false,
        windows: Array.from({ length: 7 }, (_, weekday) => ({ weekday, from: "00:00", to: "23:59" })) } };
      state.customers.push(customer);
    }
    state.waitlist ??= [];
    if (!state.waitlist.some((entry) => entry.sessionId === sessionId && entry.customerId === customer!.id)) {
      state.waitlist.push({ id: randomUUID(), sessionId, customerId: customer.id, joinedAt: new Date().toISOString() });
      repository.saveState(workspaceId, state);
    }
    const offers = repository.listWaitlistOffers(workspaceId);
    const waiting = state.waitlist.filter((entry) => entry.sessionId === sessionId && !offers.some((offer) => offer.entryId === entry.id && offer.status !== "withdrawn" && offer.status !== "offered"));
    return { position: waiting.findIndex((entry) => entry.customerId === customer!.id) + 1, title: session.title, start: session.start };
  });
}
