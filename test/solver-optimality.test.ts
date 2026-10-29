import { describe, expect, it } from "vitest";
import type { Disruption, Plan, Remedy, State } from "../lib/domain/types";
import { replan } from "../lib/solver/replan";
import { validate } from "../lib/solver/validate";
import { calculateTotals, recoveryActions } from "../lib/solver/score";

// The promise is "refund only when nothing fits": the solver may never refund more bookings than the best plan
// Rebook's own validator accepts. These tests compare it with an exhaustive search on small studios.
const NOW = "2026-11-09T00:00:00.000Z", HORIZON = "2026-11-10T00:00:00.000Z";
const sick: Disruption = { kind: "instructor_unavailable", instructorId: "i1", from: NOW, to: HORIZON };
const hour = (h: number, m = 0) => `2026-11-09T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const everyDay = (from: string, to: string) => Array.from({ length: 7 }, (_, weekday) => ({ weekday, from, to }));

function studio(parts: Pick<State, "instructors" | "rooms" | "sessions" | "customers" | "bookings">): State {
  return { studio: { id: "studio", name: "Studio", timezone: "UTC", currency: "USD", weekStart: NOW,
    openHours: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ open: "09:00", close: "13:00" }]])) }, ...parts };
}

/** Every combination of placements on the 15-minute grid (never earlier than the original class), checked by the independent validator. */
function fewestValidRefunds(state: State): number {
  const affected = state.sessions.filter((session) => session.instructorId === "i1" && session.start >= NOW);
  const options = affected.map((session) => {
    const list: Plan["sessionChanges"] = [{ sessionId: session.id, remedy: "cancel", before: session, reason: "Cancel" }];
    for (const instructor of state.instructors.filter((item) => item.skills.includes(session.classType))) {
      for (const room of state.rooms.filter((item) => item.supports.includes(session.classType))) {
        for (let minutes = 9 * 60; minutes + 60 <= 13 * 60; minutes += 15) {
          const start = hour(Math.floor(minutes / 60), minutes % 60), end = hour(Math.floor(minutes / 60) + 1, minutes % 60);
          // Policy: a recovery never moves a class earlier than customers planned for.
          if (start < session.start) continue;
          const sameTime = start === session.start;
          const remedy: Remedy = !sameTime ? "move_time" : instructor.id !== session.instructorId ? "substitute" : "move_room";
          if (sameTime && instructor.id === session.instructorId && room.id === session.roomId) continue;
          list.push({ sessionId: session.id, remedy, before: session, after: { instructorId: instructor.id, roomId: room.id, start, end }, reason: remedy });
        }
      }
    }
    return list;
  });
  let best = Infinity;
  const visit = (index: number, changes: Plan["sessionChanges"]) => {
    if (index === options.length) {
      const bookingActions = recoveryActions(state, changes);
      const plan: Plan = { disruption: sick, now: NOW, sessionChanges: changes, bookingActions,
        totals: calculateTotals(changes.length, bookingActions), warnings: [] };
      if (validate(state, plan).ok) best = Math.min(best, plan.totals.refunded);
      return;
    }
    for (const option of options[index]) visit(index + 1, [...changes, option]);
  };
  visit(0, []);
  return best;
}

describe("solver optimality", () => {
  it("does not hand the only versatile substitute to the class that had other options", () => {
    // i2 teaches yoga and pilates but only once a day; i3 teaches yoga only. Greedy session order would give i2 to
    // yoga first and leave pilates without a teacher, refunding customers who can only come on Monday morning.
    const customers = Array.from({ length: 6 }, (_, index) => ({ id: `c${index}`, name: `C${index}`, email: `c${index}@example.com`,
      prefs: { acceptsSubstitute: true, windows: [{ weekday: 1, from: "09:00", to: "10:00" }, { weekday: 1, from: "12:00", to: "13:00" }] } }));
    const state = studio({
      instructors: [{ id: "i1", name: "Sick", skills: ["yoga", "pilates"], maxSessionsPerDay: 3 },
        { id: "i2", name: "Versatile", skills: ["yoga", "pilates"], maxSessionsPerDay: 1 },
        { id: "i3", name: "Yoga only", skills: ["yoga"], maxSessionsPerDay: 3 }],
      rooms: [{ id: "r1", name: "One", supports: ["yoga", "pilates"], capacity: 10 }],
      sessions: [
        { id: "s1", title: "Yoga", classType: "yoga", instructorId: "i1", roomId: "r1", start: hour(9), end: hour(10), capacity: 10, price: "20.00" },
        { id: "s2", title: "Pilates", classType: "pilates", instructorId: "i1", roomId: "r1", start: hour(12), end: hour(13), capacity: 10, price: "20.00" }],
      customers, bookings: customers.map((customer, index) => ({ id: `b${index}`, customerId: customer.id, sessionId: index < 3 ? "s1" : "s2", status: "confirmed" as const, amount: "20.00" })),
    });
    const plan = replan(state, sick, { now: NOW, horizonEnd: HORIZON });
    expect(validate(state, plan)).toEqual({ ok: true, errors: [] });
    expect(plan.totals.refunded).toBe(0);
    expect(plan.sessionChanges.map((change) => [change.sessionId, change.after?.instructorId])).toEqual([["s1", "i3"], ["s2", "i2"]]);
    expect(fewestValidRefunds(state)).toBe(0);
  });

  it("never refunds more than the best validator-accepted plan on random small studios", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
    let compared = 0, improvedOverGreedyShape = 0;
    for (let round = 0; round < 60; round++) {
      const types: State["sessions"][number]["classType"][] = ["yoga", "pilates"];
      const instructors = [{ id: "i1", name: "Sick", skills: types, maxSessionsPerDay: 3 },
        ...[2, 3].map((n) => ({ id: `i${n}`, name: `I${n}`, skills: pick<typeof types>([["yoga"], ["pilates"], types]), maxSessionsPerDay: pick([1, 2]) }))];
      const sessions = [9, 11].map((h, index) => ({ id: `s${index + 1}`, title: "Class", classType: pick(types), instructorId: "i1", roomId: "r1",
        start: hour(h), end: hour(h + 1), capacity: pick([2, 3]), price: "20.00" }));
      if (random() < 0.5) sessions.push({ id: "s9", title: "Busy", classType: instructors[1].skills[0], instructorId: "i2", roomId: "r1", start: hour(pick([9, 10, 11])), end: "", capacity: 3, price: "20.00" });
      for (const session of sessions) if (!session.end) session.end = new Date(Date.parse(session.start) + 3_600_000).toISOString();
      const customers = Array.from({ length: 6 }, (_, index) => ({ id: `c${index}`, name: `C${index}`, email: `c${index}@example.com`,
        prefs: { acceptsSubstitute: random() < 0.7, windows: random() < 0.5 ? everyDay("09:00", "13:00") : [{ weekday: 1, from: pick(["09:00", "10:00", "11:00"]), to: pick(["11:00", "12:00", "13:00"]) }] } }));
      const bookings = customers.slice(0, 4).map((customer, index) => ({ id: `b${index}`, customerId: customer.id, sessionId: index < 2 ? "s1" : "s2", status: "confirmed" as const, amount: "20.00" }));
      const state = studio({ instructors, rooms: [{ id: "r1", name: "One", supports: types, capacity: 3 }], sessions, customers, bookings });
      const plan = replan(state, sick, { now: NOW, horizonEnd: HORIZON });
      expect(validate(state, plan).errors).toEqual([]);
      const optimum = fewestValidRefunds(state);
      expect({ round, refunded: plan.totals.refunded }).toEqual({ round, refunded: optimum });
      compared++; if (optimum < plan.totals.sessionsAffected * 2) improvedOverGreedyShape++;
    }
    expect(compared).toBe(60); expect(improvedOverGreedyShape).toBeGreaterThan(0);
  });
});
