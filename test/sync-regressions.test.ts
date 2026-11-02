import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { executePlan } from "../lib/executor/executePlan";
import { executeRefund } from "../lib/executor/refund";
import { customerChoice, submitChoice } from "../lib/choices/service";
import { askNextCover, respondToCover } from "../lib/recovery/cover-pay";
import { bookingCatalog } from "../lib/checkout/service";
import { fillFreedSeats, respondToWaitlistOffer } from "../lib/waitlist/service";
import { packBalance } from "../lib/domain/pack-balances";
import { buildInsights } from "../lib/insights/data";
import { allChanges, pendingChanges } from "../lib/sync/feed";
import { acknowledge, receiveEvents } from "../lib/sync/service";
import { paymentsNeedingAttention } from "../lib/recovery/payment-attention";

let directory: string, repository: Repository, id: string;
const state = () => repository.requireWorkspace(id).state;
const person = () => ({ name: state().customers[0].name, email: state().customers[0].email });
const balance = () => packBalance(state(), repository.listLedger(id), state().customers[0].id, "Ten");
async function snapshot(visitsLeft: number, eventId = `balance-${visitsLeft}`) {
  await receiveEvents(id, { events: [{ eventId, type: "pack.balance", customer: person(), visitsLeft }] }, repository);
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "rebook-sync-regressions-")); vi.stubEnv("DATA_DIR", directory); repository = getRepository();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function packClaim() {
  const initial = seedStudio(); initial.sessions = initial.sessions.slice(0, 2); initial.bookings = [];
  initial.waitlist = initial.sessions.map((session, index) => ({ id: `entry-${index}`, sessionId: session.id, customerId: initial.customers[0].id,
    joinedAt: new Date().toISOString(), entitlement: { kind: "pack", name: "Ten", visitsLeft: 1 } }));
  id = repository.createWorkspace(initial).id; await snapshot(1); fillFreedSeats(id, repository);
  const [first, second] = repository.listWaitlistOffers(id);
  await respondToWaitlistOffer(repository.waitlistToken(first), "claim", repository);
  return { booking: state().bookings[0], second };
}
async function hero() {
  const initial = seedStudio(); for (const booking of initial.bookings) booking.payment!.simulated = true;
  id = repository.createWorkspace(initial).id;
  for (const booking of initial.bookings) repository.appendLedger({ workspaceId: id, bookingId: booking.id, kind: "capture", amount: booking.amount,
    paypalId: booking.payment!.captureId, captureId: booking.payment!.captureId, requestId: `capture:${booking.id}`, status: "SIMULATED" });
  const plan = repository.createPlan(id, replan(initial, demoDisruption)); await executePlan(id, plan.id, repository); return plan;
}

it("acknowledges a spent pack visit without restoring it or allowing a second free claim", async () => {
  const { booking, second } = await packClaim(); expect(balance()).toBe(0);
  const before = state().syncPackBalances;
  await acknowledge(id, [`created:${booking.id}`], repository);
  expect(state().syncPackBalances).toEqual(before); expect(balance()).toBe(0);
  await respondToWaitlistOffer(repository.waitlistToken(second), "claim", repository);
  expect(state().bookings).toHaveLength(1);
  await snapshot(0); expect(balance()).toBe(0);
  expect(state().syncPackBalances?.[0].acknowledgedBookingIds).toContain(booking.id);
});
it.each([false, true])("keeps a returned visit until a new snapshot includes it (snapshot after spend: %s)", async (afterSpend) => {
  const { booking } = await packClaim(); await acknowledge(id, [`created:${booking.id}`], repository);
  if (afterSpend) await snapshot(0);
  await executeRefund(id, { bookingId: booking.id, amount: "0.00", reason: "Cancelled" }, "return", repository, () => {});
  expect(balance()).toBe(1);
  const returned = allChanges(id, repository).find((row) => row.type === "pack.visit_returned")!;
  await acknowledge(id, [returned.id], repository); expect(balance()).toBe(1);
  await snapshot(1, "after-return"); expect(balance()).toBe(1);
});
it("does not remove an imported booking's returned visit merely because its return is acknowledged", async () => {
  const initial = seedStudio(), booking = initial.bookings[0];
  booking.entitlement = { kind: "pack", name: "Ten", visitsLeft: 1 }; booking.amount = "0.00"; delete booking.payment;
  id = repository.createWorkspace(initial).id; await snapshot(1);
  await executeRefund(id, { bookingId: booking.id, amount: "0.00", reason: "Cancelled" }, "return-imported", repository, () => {});
  expect(balance()).toBe(2);
  const returned = allChanges(id, repository).find((row) => row.type === "pack.visit_returned")!;
  await acknowledge(id, [returned.id], repository); expect(balance()).toBe(2);
  await snapshot(2); expect(balance()).toBe(2);
});
it("does not recapture another customer's baseline when a pack snapshot arrives", async () => {
  const { booking } = await packClaim(); await acknowledge(id, [`created:${booking.id}`], repository);
  const before = state().syncPackBalances;
  await receiveEvents(id, { events: [{ eventId: "other-pack", type: "pack.balance", customer: { name: state().customers[1].name }, visitsLeft: 5 }] }, repository);
  expect(state().syncPackBalances?.[0]).toEqual(before?.[0]); expect(balance()).toBe(0);
});
it.each([false, true])("keeps equal-price customer move history with actual previous classes and stable ids (ack: %s)", async (ack) => {
  await hero();
  const link = repository.listCustomerLinks(id).find((row) => row.kind === "choice")!, token = repository.customerToken(link);
  const a = state().bookings.find((row) => row.id === link.bookingId)!.sessionId;
  const initial = state(), price = initial.bookings.find((row) => row.id === link.bookingId)!.amount;
  for (const session of initial.sessions) session.price = price;
  repository.saveState(id, initial); await acknowledge(id, undefined, repository);
  const b = (await customerChoice(token, repository)).alternatives[0].id;
  await submitChoice(token, { action: "move", sessionId: b }, repository);
  const first = pendingChanges(id, repository).find((row) => row.type === "booking.moved")!;
  expect(first).toMatchObject({ from: { id: a }, to: { id: b } });
  if (ack) await acknowledge(id, [first.id], repository);
  const c = (await customerChoice(token, repository)).alternatives.find((row) => row.id !== a)!.id;
  // Same clock instant: identity must not depend on timestamps alone.
  await submitChoice(token, { action: "move", sessionId: c }, repository);
  const moves = pendingChanges(id, repository).filter((row) => row.type === "booking.moved"), next = moves.at(-1)!;
  expect(moves).toHaveLength(ack ? 1 : 2); expect(next).toMatchObject({ from: { id: b }, to: { id: c } });
  expect(next.id).not.toBe(first.id); expect(allChanges(id, repository)).toContainEqual(first);
  await submitChoice(token, { action: "keep" }, repository);
  expect(allChanges(id, repository)).toContainEqual(first); expect(allChanges(id, repository)).toContainEqual(next);
});
it("exports each replacement cover from durable links after an acknowledged recovery", async () => {
  const plan = await hero(), first = repository.listCoverLinks(id)[0]; await acknowledge(id, undefined, repository);
  await respondToCover(repository.coverToken(first), "decline", repository);
  await askNextCover(id, plan.id, first.sessionId, repository);
  const links = repository.listCoverLinks(id).filter((row) => row.sessionId === first.sessionId), replacement = links[1];
  const changes = pendingChanges(id, repository);
  expect(changes).toHaveLength(1);
  const session = state().sessions.find((row) => row.id === first.sessionId)!;
  expect(changes[0]).toMatchObject({ id: `cover:${replacement.id}`, occurredAt: replacement.createdAt, type: "session.moved",
    before: { instructor: state().instructors.find((row) => row.id === first.instructorId)!.name, start: session.start, room: "Movement Hall" },
    after: { instructor: state().instructors.find((row) => row.id === replacement.instructorId)!.name, start: session.start, room: "Movement Hall" } });
  await acknowledge(id, [changes[0].id], repository); expect(pendingChanges(id, repository)).toEqual([]);
  expect(allChanges(id, repository)).toContainEqual(changes[0]);
});
it("imports a full class's replacement before offering its freed seat to the waitlist", async () => {
  const initial = seedStudio(); initial.sessions = [initial.sessions[0]]; initial.sessions[0].capacity = 1; initial.bookings = [initial.bookings[0]]; initial.bookings[0].payment!.simulated = true;
  initial.waitlist = [{ id: "waiting", sessionId: initial.sessions[0].id, customerId: initial.customers[1].id, joinedAt: new Date().toISOString() }];
  id = repository.createWorkspace(initial).id;
  const result = await receiveEvents(id, { events: [
    { eventId: "cancel", type: "booking.cancelled", session: { id: initial.sessions[0].id }, customer: person() },
    { eventId: "replacement", type: "booking.created", session: { id: initial.sessions[0].id }, customer: { name: initial.customers[2].name } },
  ] }, repository);
  expect(result.results.map((row) => row.status)).toEqual(["applied", "applied"]);
  expect(repository.listWaitlistOffers(id)).toEqual([]); expect(repository.listLedger(id).filter((row) => row.kind === "refund")).toEqual([]);
});
it("cancels a class without money movement, retaining details and excluding it from all booking paths", async () => {
  await hero(); const links = repository.listCustomerLinks(id).filter((row) => row.kind === "choice"), link = links[0];
  const initial = state(), session = initial.sessions.find((row) => row.id === initial.bookings.find((row) => row.id === link.bookingId)!.sessionId)!;
  initial.waitlist = [{ id: "waiting", sessionId: session.id, customerId: initial.customers.at(-1)!.id, joinedAt: new Date().toISOString() }];
  repository.saveState(id, initial); fillFreedSeats(id, repository);
  const before = repository.listLedger(id), feed = allChanges(id, repository), offers = repository.listWaitlistOffers(id), offer = offers.find((row) => row.sessionId === session.id)!; expect(offer).toBeTruthy();
  const result = await receiveEvents(id, { events: [{ eventId: "cancel-class", type: "session.cancelled", session: { id: session.id } }] }, repository);
  expect(result.results[0].status).toBe("applied");
  expect(state().bookings.filter((row) => row.sessionId === session.id && ["confirmed", "moved"].includes(row.status))).toEqual([]);
  expect(state().waitlist).toEqual([]); expect(repository.listWaitlistOffers(id).find((row) => row.id === offer.id)?.status).toBe("withdrawn");
  expect(bookingCatalog(id, repository).sessions.some((row) => row.id === session.id)).toBe(false);
  expect(state().sessions.some((row) => row.id === session.id)).toBe(false); expect(state().cancelledSessions?.map((row) => row.id)).toEqual([session.id]);
  expect((await customerChoice(repository.customerToken(link), repository)).canChoose).toBe(false);
  const other = links.find((row) => initial.bookings.find((booking) => booking.id === row.bookingId)!.sessionId !== session.id)!;
  expect((await customerChoice(repository.customerToken(other), repository)).alternatives.some((row) => row.id === session.id)).toBe(false);
  fillFreedSeats(id, repository); expect(repository.listWaitlistOffers(id)).toHaveLength(offers.length);
  expect(buildInsights(state(), repository.listPlans(id), repository.listLedger(id)).sessions.find((row) => row.id === session.id)?.title).toBe(session.title);
  expect(allChanges(id, repository)).toEqual(feed); expect(repository.listLedger(id)).toEqual(before);
  expect((await receiveEvents(id, { events: [{ eventId: "revive", type: "booking.created", session: { id: session.id }, customer: person() }] }, repository)).results[0]).toMatchObject({ status: "rejected" });
});

it("hands a cancelled booking to the owner when Rebook holds its payment, and moves no money", async () => {
  const initial = seedStudio(); initial.sessions = [initial.sessions[0]]; initial.sessions[0].capacity = 9;
  initial.bookings = [initial.bookings[0], initial.bookings[1]]; for (const booking of initial.bookings) booking.sessionId = initial.sessions[0].id;
  initial.bookings[1].payment!.simulated = true;
  id = repository.createWorkspace(initial).id;
  const [held, upstream] = initial.bookings, name = (booking: typeof held) => initial.customers.find((row) => row.id === booking.customerId)!;
  const cancel = (eventId: string, booking: typeof held) => receiveEvents(id, { events: [{ eventId, type: "booking.cancelled", session: { id: initial.sessions[0].id }, customer: { name: name(booking).name, email: name(booking).email } }] }, repository);
  await cancel("held", held); await cancel("upstream", upstream);
  expect(state().bookings.find((row) => row.id === upstream.id)?.status).toBe("cancelled");
  expect(state().bookings.find((row) => row.id === held.id)?.status).toBe("refund_pending");
  const attention = paymentsNeedingAttention(state(), repository.latestMoneyEvents(id));
  expect(attention).toEqual([expect.objectContaining({ requestId: `sync:${id}:${held.id}`, status: "FAILED", message: expect.stringContaining("Rebook still holds") })]);
  expect(repository.listLedger(id).filter((row) => row.kind === "refund" && row.status !== "FAILED")).toEqual([]);
});
it("records an inbound paid booking as simulated, so a recovery's refund settles instead of failing forever", async () => {
  const initial = seedStudio(); initial.sessions = [initial.sessions[0]]; initial.sessions[0].capacity = 9; initial.bookings = [];
  id = repository.createWorkspace(initial).id;
  await receiveEvents(id, { events: [{ eventId: "paid", type: "booking.created", session: { id: initial.sessions[0].id }, customer: person(), amount: "22.00" }] }, repository);
  const [booking] = state().bookings;
  expect(booking.payment).toMatchObject({ simulated: true });
  expect(await executeRefund(id, { bookingId: booking.id, amount: "22.00", reason: "Recovery" }, "plan:refund", repository, () => {})).toMatchObject({ status: "SIMULATED" });
  expect(state().bookings[0].status).toBe("refunded");
});

it("keeps an earlier move's event unchanged when its class is rescheduled later", async () => {
  await hero();
  const link = repository.listCustomerLinks(id).find((row) => row.kind === "choice" && !state().bookings.find((booking) => booking.id === row.bookingId)?.entitlement)!;
  const token = repository.customerToken(link), [target] = (await customerChoice(token, repository)).alternatives;
  await submitChoice(token, { action: "move", sessionId: target.id }, repository);
  const event = () => allChanges(id, repository).find((row) => row.id.startsWith(`choice:${link.id}:`))!, before = structuredClone(event());
  const later = state(), session = later.sessions.find((row) => row.id === target.id)!;
  session.start = new Date(Date.parse(session.start) + 3_600_000).toISOString(); session.end = new Date(Date.parse(session.end) + 3_600_000).toISOString();
  repository.saveState(id, later);
  expect(event()).toEqual(before);
});
