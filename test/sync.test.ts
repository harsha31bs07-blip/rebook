import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { executePlan } from "../lib/executor/executePlan";
import { customerChoice, submitChoice } from "../lib/choices/service";
import { planCorrection } from "../lib/solver/correction";
import { fillFreedSeats, respondToWaitlistOffer } from "../lib/waitlist/service";
import { packBalance } from "../lib/domain/pack-balances";
import { changeFeed, allChanges, pendingChanges } from "../lib/sync/feed";
import { acknowledge, receiveEvents, ownerSync } from "../lib/sync/service";
import type { InboundEvent } from "../lib/sync/schemas";
import { limits } from "../lib/api/limits";
import { GET } from "../app/api/workspaces/[id]/sync/changes/route";
import { POST as ackPost } from "../app/api/workspaces/[id]/sync/ack/route";
import { POST as eventsPost } from "../app/api/workspaces/[id]/sync/events/route";
import { POST as ackAllPost } from "../app/api/workspaces/[id]/sync/ack-all/route";
import { GET as csvGet } from "../app/api/workspaces/[id]/pack-balances/route";

let directory: string, repository: Repository, id: string;
const context = () => ({ params: Promise.resolve({ id }) });
const request = (body?: unknown, key = repository.syncKey(id), origin?: string) => new Request("http://localhost/api/sync", {
  method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const state = () => repository.requireWorkspace(id).state;
function setup(capacity = 2) {
  const initial = seedStudio(); initial.sessions = [initial.sessions[0]]; initial.sessions[0].capacity = capacity;
  initial.bookings = []; initial.waitlist = [];
  id = repository.createWorkspace(initial).id;
  return initial;
}
async function event(input: InboundEvent) { return (await receiveEvents(id, { events: [input] }, repository)).results[0]; }
const ref = () => ({ id: state().sessions[0].id });
const customer = (index = 0) => ({ name: state().customers[index].name, email: state().customers[index].email });
async function hero() {
  const initial = seedStudio(); for (const booking of initial.bookings) booking.payment!.simulated = true;
  id = repository.createWorkspace(initial).id;
  for (const booking of initial.bookings) repository.appendLedger({ workspaceId: id, bookingId: booking.id, kind: "capture", amount: booking.amount,
    paypalId: booking.payment!.captureId, captureId: booking.payment!.captureId, requestId: `capture:${booking.id}`, status: "SIMULATED" });
  const plan = repository.createPlan(id, replan(initial, demoDisruption));
  await executePlan(id, plan.id, repository); return plan;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "rebook-sync-")); vi.stubEnv("DATA_DIR", directory);
  repository = getRepository(); limits.reset(); setup();
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("authenticates only the workspace sync HMAC in its own domain", async () => {
  const other = repository.createWorkspace(seedStudio()).id;
  const tokens = ["", "x".repeat(43), repository.syncKey(other), repository.customerToken({ id } as Parameters<Repository["customerToken"]>[0]),
    repository.coverToken({ id }), repository.waitlistToken({ id }), repository.creditToken({ id })];
  for (const key of tokens) {
    expect((await GET(request(undefined, key), context())).status).toBe(401);
    expect((await ackPost(request({ ids: [] }, key), context())).status).toBe(401);
    expect((await eventsPost(request({ events: [] }, key), context())).status).toBe(401);
  }
  expect((await GET(new Request("http://localhost"), context())).status).toBe(401);
  expect(repository.syncKey(id)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await GET(request(undefined, undefined, "https://middleware.example"), context())).status).toBe(200);
  id = "abcdefghij"; expect((await GET(request(), context())).status).toBe(404);
});
it("rate limits per workspace and client", async () => {
  for (let index = 0; index < 60; index++) expect((await GET(request(), context())).status).toBe(200);
  const limited = await GET(request(), context()); expect(limited.status).toBe(429); expect(limited.headers.get("Retry-After")).toBeTruthy();
  const another = request(); another.headers.set("x-forwarded-for", "192.0.2.1"); expect((await GET(another, context())).status).toBe(200);
});
it("derives a stable hero feed with booking moves, refunds, pending count and idempotent acknowledgements", async () => {
  const plan = await hero();
  expect(plan.totals).toMatchObject({ kept: 9, moved: 16, refunded: 6, revenueKept: "577.00", refundAmount: "135.00" });
  const feed = changeFeed(id, repository);
  expect(feed.changes.filter((row) => row.type === "session.moved")).toHaveLength(plan.sessionChanges.length);
  expect(feed.changes.filter((row) => row.type === "booking.moved")).toHaveLength(16);
  const refunds = feed.changes.filter((row) => row.type === "booking.cancelled");
  expect(refunds).toHaveLength(6); expect(refunds.every((row) => row.reason === "refunded" && row.amount)).toBe(true);
  expect(changeFeed(id, repository)).toEqual(feed);
  const ids = feed.changes.slice(0, 2).map((row) => row.id);
  expect(await acknowledge(id, [...ids, "unknown", ids[0]], repository)).toEqual({ acknowledged: 2, pending: feed.pending - 2 });
  expect(await acknowledge(id, ids, repository)).toEqual({ acknowledged: 0, pending: feed.pending - 2 });
  expect((await ackPost(request({ ids: pendingChanges(id, repository).map((row) => row.id) }), context())).status).toBe(200);
  expect(changeFeed(id, repository)).toEqual({ changes: [], pending: 0 });
});
it("includes a customer move and an entitled waitlist claim without duplicating created bookings", async () => {
  await hero();
  const link = repository.listCustomerLinks(id).find((row) => row.kind === "choice")!;
  const token = repository.customerToken(link), view = await customerChoice(token, repository);
  expect(view.alternatives.length).toBeGreaterThan(0);
  await submitChoice(token, { action: "move", sessionId: view.alternatives[0].id }, repository);
  expect(allChanges(id, repository).some((row) => row.type === "booking.moved" && row.id.startsWith(`choice:${link.id}:`)
    && row.to.id === view.alternatives[0].id)).toBe(true);
  setup(1);
  const initial = state(); initial.waitlist = [{ id: "entry", sessionId: ref().id, customerId: initial.customers[0].id,
    joinedAt: new Date().toISOString(), entitlement: { kind: "pack", name: "Ten", visitsLeft: 4 } }];
  repository.saveState(id, initial); fillFreedSeats(id, repository);
  const offer = repository.listWaitlistOffers(id)[0]; await respondToWaitlistOffer(repository.waitlistToken(offer), "claim", repository);
  expect(changeFeed(id, repository).changes).toMatchObject([{ type: "booking.created", source: "waitlist", customer: { name: customer().name }, amount: "0.00" }]);
});
it("exports customer credits, approved corrections and removed session snapshots", async () => {
  const original = await hero();
  const link = repository.listCustomerLinks(id).find((row) => row.kind === "choice")!;
  await submitChoice(repository.customerToken(link), { action: "credit" }, repository);
  expect(allChanges(id, repository).some((row) => row.type === "booking.cancelled" && row.reason === "credited")).toBe(true);
  const approved = repository.getPlan(id, original.id)!;
  const correction = repository.createPlan(id, planCorrection(state(), approved, new Date().toISOString()));
  await executePlan(id, correction.id, repository);
  const moves = allChanges(id, repository).filter((row) => row.type === "session.moved" && row.id.startsWith(`plan:${correction.id}:`));
  expect(moves).toHaveLength(correction.sessionChanges.length);
  expect(moves[0]).toMatchObject({ before: { start: correction.sessionChanges[0].before.start }, after: { start: correction.sessionChanges[0].after!.start } });
  const basis = state(), session = basis.sessions[0];
  const cancelled = repository.createPlan(id, { ...correction, correctionOf: undefined,
    sessionChanges: [{ sessionId: session.id, before: session, remedy: "cancel", reason: "Closed" }], bookingActions: [] });
  repository.savePlan({ ...cancelled, status: "executed", basis });
  repository.saveState(id, { ...basis, sessions: basis.sessions.filter((row) => row.id !== session.id) });
  expect(allChanges(id, repository).find((row) => row.id === `plan:${cancelled.id}:session:${session.id}`)).toMatchObject({ type: "session.cancelled", session: { id: session.id, title: session.title } });
});
it("caps feed pages at 200, counts all pending records and emits paid waitlist checkouts once", async () => {
  const initial = state(), session = initial.sessions[0], person = initial.customers[0];
  for (let index = 0; index < 205; index++) {
    const bookingId = `checkout-${index}`;
    initial.bookings.push({ id: bookingId, customerId: person.id, sessionId: session.id, status: "confirmed", amount: "22.00", bookedAt: new Date(Date.now() + index).toISOString() });
    repository.saveCheckout({ id: bookingId, workspaceId: id, requestId: bookingId, sessionId: session.id, session, customer: customer(), amount: "22.00",
      currency: "USD", expiresAt: Date.now(), status: "confirmed", captureId: `capture-${index}`, ...(index ? {} : { waitlistOfferId: "placeholder" }) });
  }
  const offer = repository.createWaitlistOffer({ workspaceId: id, entryId: "entry", customerId: person.id, sessionId: session.id, expiresAt: new Date().toISOString() });
  repository.saveWaitlistOffer({ ...offer, status: "claimed", bookingId: "checkout-0", respondedAt: new Date().toISOString() });
  repository.saveState(id, initial);
  const feed = changeFeed(id, repository);
  expect(feed.pending).toBe(205); expect(feed.changes).toHaveLength(200);
  expect(allChanges(id, repository).filter((row) => row.id === "created:checkout-0")).toMatchObject([{ source: "waitlist", amount: "22.00" }]);
  expect(allChanges(id, repository).filter((row) => row.type === "booking.created" && row.source === "checkout")).toHaveLength(204);
  await acknowledge(id, feed.changes.map((row) => row.id), repository);
  expect(changeFeed(id, repository).pending).toBe(5);
});
it("applies booking creation, matches title/instant and email, rejects duplicates and never echoes inbound bookings", async () => {
  const session = state().sessions[0], known = customer();
  const input: InboundEvent = { eventId: "create", type: "booking.created", session: { title: session.title.toUpperCase(), start: session.start }, customer: { ...known, email: known.email.toUpperCase() }, amount: "22.00" };
  expect(await event(input)).toEqual({ eventId: "create", status: "applied" });
  expect(await event(input)).toEqual({ eventId: "create", status: "duplicate" });
  expect(await event({ ...input, eventId: "again" })).toMatchObject({ status: "rejected", message: "Customer is already booked in this class" });
  expect(state().bookings).toHaveLength(1); expect(state().bookings[0].payment).toBeUndefined();
  expect(changeFeed(id, repository).pending).toBe(0); expect(repository.listLedger(id)).toEqual([]);
});
it("creates customers only for bookings and joining, including optional entitlement names", async () => {
  expect(await event({ eventId: "missing", type: "pack.balance", customer: { name: "New" }, visitsLeft: 3 })).toMatchObject({ status: "rejected", message: "Customer not found" });
  expect(await event({ eventId: "new", type: "booking.created", session: ref(), customer: { name: "New" }, entitlement: { kind: "pack", name: "Ten", visitsLeft: 3 } })).toMatchObject({ status: "applied" });
  expect(state().customers.find((row) => row.name === "New")).toBeTruthy();
  const response = await eventsPost(request({ events: [{ eventId: "membership", type: "booking.created", session: ref(), customer: { name: "Member", email: "member@example.com" }, entitlement: { kind: "membership" } }] }), context());
  expect(await response.json()).toMatchObject({ results: [{ status: "applied" }] });
  expect(state().bookings.at(-1)?.entitlement).toEqual({ kind: "membership", name: "Membership" });
});
it("never attaches a booking to a same-name member with another email, and new customers fit any time", async () => {
  setup(3);
  await event({ eventId: "first", type: "booking.created", session: ref(), customer: { name: "Sam Lee", email: "sam@example.com" } });
  await event({ eventId: "second", type: "booking.created", session: ref(), customer: { name: "Sam Lee", email: "sam.other@example.com" } });
  const people = state().customers.filter((row) => row.name === "Sam Lee");
  expect(people.map((row) => row.email).sort()).toEqual(["sam.other@example.com", "sam@example.com"]);
  expect(new Set(state().bookings.map((row) => row.customerId)).size).toBe(2);
  expect(people[0].prefs.windows).toHaveLength(7);
});
it("rejects full, missing, started and cancelled classes, re-evaluating rejected replays", async () => {
  setup(1); await event({ eventId: "first", type: "booking.created", session: ref(), customer: customer() });
  const full: InboundEvent = { eventId: "full", type: "booking.created", session: ref(), customer: customer(1) };
  expect(await event(full)).toMatchObject({ status: "rejected", message: "Class is full" });
  expect(await event(full)).toMatchObject({ status: "rejected", message: "Class is full" });
  expect(repository.listSyncEvents(id).filter((row) => row.eventId === "full")).toHaveLength(1);
  expect(await event({ ...full, eventId: "unknown", session: { id: "missing" } })).toMatchObject({ status: "rejected", message: "Session not found or cancelled" });
  const initial = state(); initial.sessions[0].start = "2026-11-01T12:00:00Z"; repository.saveState(id, initial);
  expect(await event({ ...full, eventId: "past" })).toMatchObject({ status: "rejected", message: "Class has already started" });
});
it("cancellation frees a seat for a waitlist offer, leaving money alone; leaving withdraws the offer", async () => {
  setup(1);
  await event({ eventId: "book", type: "booking.created", session: ref(), customer: customer() });
  await event({ eventId: "join", type: "waitlist.joined", session: ref(), customer: customer(1) });
  expect(repository.listWaitlistOffers(id)).toEqual([]);
  expect(await event({ eventId: "cancel", type: "booking.cancelled", session: ref(), customer: customer() })).toMatchObject({ status: "applied" });
  expect(state().bookings[0].status).toBe("cancelled"); expect(repository.listWaitlistOffers(id)[0].status).toBe("offered");
  expect(await event({ eventId: "left", type: "waitlist.left", session: ref(), customer: customer(1) })).toMatchObject({ status: "applied" });
  expect(state().waitlist).toEqual([]); expect(repository.listWaitlistOffers(id)[0].status).toBe("withdrawn");
  expect(allChanges(id, repository)).toEqual([]); expect(repository.listLedger(id)).toEqual([]);
});
it("capacity increases offer seats and decreases respect bookings, checkout holds and open offers", async () => {
  setup(1);
  await event({ eventId: "book", type: "booking.created", session: ref(), customer: customer() });
  await event({ eventId: "join", type: "waitlist.joined", session: ref(), customer: customer(1) });
  expect(await event({ eventId: "grow", type: "session.capacity", session: ref(), capacity: 2 })).toMatchObject({ status: "applied" });
  expect(repository.listWaitlistOffers(id)[0].status).toBe("offered");
  expect(await event({ eventId: "shrink", type: "session.capacity", session: ref(), capacity: 1 })).toMatchObject({ status: "rejected", message: "Capacity is below booked and held seats" });
  expect(await event({ eventId: "room", type: "session.capacity", session: ref(), capacity: 1000 })).toMatchObject({ status: "rejected", message: "Capacity exceeds room capacity" });
  const session = state().sessions[0];
  repository.saveCheckout({ id: "held", requestId: "held", workspaceId: id, sessionId: session.id, customer: customer(2), session, amount: "22.00", currency: "USD", status: "pending", expiresAt: Date.now() + 60_000 });
  expect(await event({ eventId: "held", type: "booking.created", session: ref(), customer: customer(2) })).toMatchObject({ status: "rejected", message: "Class is full" });
});
it("reserves checkout seats for inbound booking and capacity checks", async () => {
  setup(2);
  await event({ eventId: "active", type: "booking.created", session: ref(), customer: customer() });
  const session = state().sessions[0];
  repository.saveCheckout({ id: "checkout-hold", requestId: "checkout-hold", workspaceId: id, sessionId: session.id, customer: customer(1), session, amount: "22.00", currency: "USD", status: "pending", expiresAt: Date.now() + 60_000 });
  expect(await event({ eventId: "full-from-hold", type: "booking.created", session: ref(), customer: customer(2) })).toMatchObject({ status: "rejected", message: "Class is full" });
  expect(await event({ eventId: "shrink-below-hold", type: "session.capacity", session: ref(), capacity: 1 })).toMatchObject({ status: "rejected", message: "Capacity is below booked and held seats" });
  vi.setSystemTime(new Date(Date.now() + 61_000));
  expect(await event({ eventId: "after-hold", type: "booking.created", session: ref(), customer: customer(2) })).toMatchObject({ status: "applied" });
});
it("protects open previews and applies a retry with the same event id after discard", async () => {
  const initial = seedStudio(); id = repository.createWorkspace(initial).id;
  const plan = repository.createPlan(id, replan(initial, demoDisruption));
  const input: InboundEvent = { eventId: "preview", type: "session.capacity", session: { id: initial.sessions[0].id }, capacity: initial.sessions[0].capacity };
  expect(await event(input)).toMatchObject({ status: "rejected", message: "A recovery preview is open; approve or discard it first." });
  repository.discardPlan(id, plan.id);
  expect(await event(input)).toMatchObject({ status: "applied" });
  expect(await event(input)).toMatchObject({ status: "duplicate" });
});
it("keeps sync journals workspace-scoped and removes them on reset and pruning", async () => {
  await event({ eventId: "same-vendor-id", type: "booking.created", session: ref(), customer: customer() });
  repository.acknowledgeSync(id, ["old-change"]);
  repository.clearPlans(id);
  expect(repository.listSyncEvents(id)).toEqual([]); expect(repository.syncAcks(id).size).toBe(0);
  await event({ eventId: "same-vendor-id", type: "session.capacity", session: ref(), capacity: 2 });
  repository.acknowledgeSync(id, ["prune-change"]);
  repository.pruneOlderThan(-1);
  expect(repository.getWorkspace(id)).toBeUndefined(); expect(repository.listSyncEvents(id)).toEqual([]); expect(repository.syncAcks(id).size).toBe(0);
});
it("adds only unacknowledged visit returns to inbound pack baselines and filters pending CSV", async () => {
  const initial = state(), session = initial.sessions[0], person = initial.customers[0];
  initial.bookings = [0, 1].map((index) => ({ id: `pack-${index}`, sessionId: session.id, customerId: person.id, amount: "0.00", status: "refunded", entitlement: { kind: "pack", name: "Ten", visitsLeft: 3 } }));
  initial.bookings.push({ id: "membership", sessionId: session.id, customerId: person.id, amount: "0.00", status: "refunded", entitlement: { kind: "membership", name: "Unlimited" } });
  repository.saveState(id, initial);
  for (const booking of initial.bookings) repository.appendLedger({ workspaceId: id, bookingId: booking.id, kind: "refund", amount: "0.00", paypalId: "", captureId: "", requestId: `return:${booking.id}`, status: "VISIT_RETURNED" });
  const returns = allChanges(id, repository).filter((row) => row.type === "pack.visit_returned");
  await acknowledge(id, [returns[0].id], repository);
  expect(await event({ eventId: "balance", type: "pack.balance", customer: customer(), visitsLeft: 10, expires: "2026-12-01" })).toMatchObject({ status: "applied" });
  expect(packBalance(state(), repository.listLedger(id), person.id, "Ten")).toBe(11);
  const csv = () => csvGet(new Request("http://localhost/pack-balances?pending=1"), context());
  expect((await (await csv()).text()).trim().split("\r\n")).toHaveLength(2);
  await acknowledge(id, [returns[1].id], repository);
  expect(packBalance(state(), repository.listLedger(id), person.id, "Ten")).toBe(10);
  expect((await (await csv()).text()).trim().split("\r\n")).toHaveLength(1);
  expect((await (await csvGet(new Request("http://localhost/pack-balances"), context())).text()).trim().split("\r\n")).toHaveLength(3);
});
it("validates event/ack limits and body size and protects owner ack-all by origin", async () => {
  const input = { eventId: "one", type: "booking.created", session: ref(), customer: customer() };
  for (const events of [[], Array.from({ length: 101 }, () => input), [{ ...input, eventId: "a".repeat(101) }], [{ ...input, amount: "NaN" }]])
    expect((await eventsPost(request({ events }), context())).status).toBe(400);
  expect((await eventsPost(request({ events: [input], padding: "x".repeat(205_000) }), context())).status).toBe(413);
  expect((await ackPost(request({ ids: Array.from({ length: 501 }, () => "x") }), context())).status).toBe(400);
  expect((await ackAllPost(request({}, undefined, "https://evil.example"), context())).status).toBe(403);
  await hero();
  const response = await ackAllPost(new Request("http://localhost/ack-all", { method: "POST", body: "{}" }), context());
  expect(await response.json()).toMatchObject({ pending: 0 });
  expect(ownerSync(id, repository).pending).toBe(0);
});
