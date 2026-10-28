import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckoutInputSchema, confirmOrder, createOrder, type CheckoutInput } from "../lib/checkout/service";
import { Repository, type CheckoutReservation } from "../lib/store";
import { limits } from "../lib/api/limits";
import { seedStudio } from "../lib/seed/seed";
import { zonedTimeToUtc } from "../lib/domain/time";
import { replan } from "../lib/solver/replan";
import { validate } from "../lib/solver/validate";
import { createBookingOrder } from "../lib/paypal/client";

vi.mock("../lib/paypal/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/paypal/client")>(),
  createBookingOrder: vi.fn(async () => ({ id: randomUUID(), status: "CREATED" })),
}));

let directory: string, repository: Repository, workspaceId: string, sessionId: string;
const customer = { name: "Checkout Customer", email: "checkout@example.com" };
const input = (availability?: CheckoutInput["availability"]) => ({ sessionId, customer, availability });
const windows = (days: number[], from: string, to: string) => days.map((weekday) => ({ weekday, from, to }));
const allDays = [0, 1, 2, 3, 4, 5, 6];
function confirm(row: CheckoutReservation) {
  const amount = { value: row.amount, currency_code: row.currency };
  return confirmOrder(row, { id: row.orderId!, status: "COMPLETED", purchase_units: [{ reference_id: row.id,
    custom_id: row.paypalCustomId, amount, payments: { captures: [{ id: `capture-${row.id}`, status: "COMPLETED", amount }] } }] }, repository);
}
async function book(availability?: CheckoutInput["availability"], email = customer.email) {
  const { orderId } = await createOrder(workspaceId, { ...input(availability), customer: { ...customer, email } }, randomUUID(), repository);
  confirm(repository.checkoutByOrder(workspaceId, orderId)!);
  return repository.requireWorkspace(workspaceId).state;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "rebook-availability-")); repository = new Repository(directory);
  const state = seedStudio(); state.bookings = []; state.customers = [];
  workspaceId = repository.createWorkspace(state).id; sessionId = state.sessions[0].id;
  limits.reset(); vi.mocked(createBookingOrder).mockClear();
});
afterEach(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });

describe("checkout availability", () => {
  it.each([undefined, {}, { times: ["mornings", "afternoons", "evenings"], days: ["weekdays", "weekends"], acceptsSubstitute: false },
    { times: [], days: [] }, { acceptsSubstitute: true }])("accepts optional distinct choices: %j", (availability) => {
    expect(CheckoutInputSchema.safeParse(input(availability as CheckoutInput["availability"])).success).toBe(true);
  });
  it.each([null, [], { extra: true }, { times: ["morning"] }, { days: ["Monday"] }, { acceptsSubstitute: "yes" },
    { times: ["mornings", "mornings"] }, { days: ["weekdays", "weekdays"] },
    { times: ["mornings", "afternoons", "evenings", "mornings"] }, { days: ["weekdays", "weekends", "weekdays"] }])("rejects invalid choices: %j", (availability) => {
    expect(CheckoutInputSchema.safeParse({ sessionId, customer, availability }).success).toBe(false);
  });
  it.each([
    { availability: undefined, expected: windows(allDays, "00:00", "23:59"), known: false },
    { availability: {}, expected: windows(allDays, "07:00", "21:00"), known: true },
    { availability: { times: ["mornings"] }, expected: windows(allDays, "07:00", "12:00"), known: true },
    { availability: { times: ["afternoons"], days: ["weekdays"] }, expected: windows([1, 2, 3, 4, 5], "12:00", "17:00"), known: true },
    { availability: { times: ["evenings"], days: ["weekends"], acceptsSubstitute: false }, expected: windows([0, 6], "17:00", "21:00"), known: true },
    { availability: { times: ["mornings", "evenings"], days: ["weekends", "weekdays"] }, expected: allDays.flatMap((weekday) => [
      { weekday, from: "07:00", to: "12:00" }, { weekday, from: "17:00", to: "21:00" }]), known: true },
    { availability: { days: ["weekdays"] }, expected: windows([1, 2, 3, 4, 5], "07:00", "21:00"), known: true },
    { availability: { acceptsSubstitute: false }, expected: windows(allDays, "07:00", "21:00"), known: true },
    { availability: { times: [] }, expected: [], known: true },
    { availability: { days: [] }, expected: [], known: true },
  ])("builds preferences from %j", async ({ availability, expected, known }) => {
    const state = await book(availability as CheckoutInput["availability"]);
    expect(state.customers[0].prefs).toEqual({ windows: expected, availabilityKnown: known,
      acceptsSubstitute: availability?.acceptsSubstitute ?? true });
  });
  it("persists the answer across repository restarts and replays the original order key", async () => {
    const availability: CheckoutInput["availability"] = { times: ["evenings"], days: ["weekdays"], acceptsSubstitute: false };
    const key = randomUUID(), original = await createOrder(workspaceId, input(availability), key, repository);
    repository.close(); repository = new Repository(directory);
    expect(repository.checkoutByOrder(workspaceId, original.orderId)?.availability).toEqual(availability);
    expect(await createOrder(workspaceId, input(availability), key, repository)).toEqual(original);
    expect(createBookingOrder).toHaveBeenCalledTimes(1);
    const row = repository.checkoutByOrder(workspaceId, original.orderId)!;
    expect(vi.mocked(createBookingOrder).mock.calls[0][1].requestId).toBe(row.id);
    confirm(row);
    expect(repository.requireWorkspace(workspaceId).state.customers[0].prefs.windows).toEqual(windows([1, 2, 3, 4, 5], "17:00", "21:00"));
    await expect(createOrder(workspaceId, input({ times: ["mornings"] }), key, repository)).rejects.toMatchObject({ status: 409 });
  });
  it("preserves a reused customer's preferences without an answer and replaces availability when answered", async () => {
    let state = await book({ times: ["mornings"], acceptsSubstitute: false });
    const original = { ...state.customers[0].prefs, preferredInstructorIds: [state.sessions[0].instructorId], refundOnly: true };
    state.customers[0].prefs = original; repository.saveState(workspaceId, state);
    state = await book(undefined, "CHECKOUT@example.com");
    expect(state.customers).toHaveLength(1); expect(state.customers[0].prefs).toEqual(original);
    state = await book({ times: ["evenings"], days: ["weekends"] });
    expect(state.customers).toHaveLength(1);
    expect(state.customers[0].prefs).toEqual({ ...original, windows: windows([0, 6], "17:00", "21:00"), acceptsSubstitute: true, availabilityKnown: true });
  });
  it("leaves legacy preferences untouched when a reused customer gives no answer", async () => {
    const { state } = repository.requireWorkspace(workspaceId);
    const original = { acceptsSubstitute: false, windows: windows([1], "09:00", "10:00") };
    state.customers.push({ id: "existing", ...customer, prefs: original }); repository.saveState(workspaceId, state);
    const updated = await book();
    expect(updated.customers).toEqual([{ id: "existing", ...customer, prefs: original }]);
  });
  it("does not fit an evening-only checkout customer into Tuesday at 12:15 during recovery", async () => {
    const { state } = repository.requireWorkspace(workspaceId), tz = state.studio.timezone;
    state.sessions = [{ ...state.sessions[0], start: zonedTimeToUtc("2026-11-09", "12:15", tz), end: zonedTimeToUtc("2026-11-09", "13:15", tz) }];
    state.instructors = state.instructors.filter((item) => item.id === state.sessions[0].instructorId);
    state.rooms = state.rooms.filter((item) => item.id === state.sessions[0].roomId);
    state.studio.openHours = { 1: [{ open: "12:15", close: "13:15" }], 2: [{ open: "12:15", close: "13:15" }] };
    repository.saveState(workspaceId, state);
    const booked = await book({ times: ["evenings"] });
    const disruption = { kind: "closure" as const, from: zonedTimeToUtc("2026-11-09", "00:00", tz), to: zonedTimeToUtc("2026-11-10", "00:00", tz) };
    const options = { now: "2026-11-09T00:00:00Z", horizonDays: 2 };
    const broad = structuredClone(booked); broad.customers[0].prefs.windows = windows(allDays, "00:00", "23:59");
    const assumed = replan(broad, disruption, options);
    expect(assumed.sessionChanges[0].after?.start).toBe(zonedTimeToUtc("2026-11-10", "12:15", tz));
    expect(assumed.totals.moved).toBe(1);
    const actual = replan(booked, disruption, options);
    expect(actual.bookingActions[0].action).toBe("refund"); expect(actual.totals.moved).toBe(0);
    expect(actual.totals.refunded).toBe(1); expect(validate(booked, actual)).toEqual({ ok: true, errors: [] });
  });
});
