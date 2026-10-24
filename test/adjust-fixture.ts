import type { Disruption, State } from "../lib/domain/types";

export const disruption: Disruption = { kind: "instructor_unavailable", instructorId: "i1", from: "2026-11-09T00:00:00Z", to: "2026-11-10T00:00:00Z" };
export function adjustmentFixture(): State {
  return {
    studio: { id: "studio", name: "Studio", timezone: "UTC", currency: "USD", weekStart: "2026-11-09T00:00:00Z",
      openHours: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ open: "07:00", close: "21:00" }]])) },
    instructors: [
      { id: "i1", name: "Maya", skills: ["yoga"], maxSessionsPerDay: 3 },
      { id: "i2", name: "Alex", skills: ["yoga"], maxSessionsPerDay: 3 },
      { id: "i3", name: "Sam", skills: ["spin"], maxSessionsPerDay: 3 },
    ],
    rooms: [
      { id: "r1", name: "Hall", supports: ["yoga"], capacity: 10 },
      { id: "r2", name: "Small", supports: ["yoga"], capacity: 1 },
    ],
    sessions: [
      { id: "s1", title: "Yoga", classType: "yoga", instructorId: "i1", roomId: "r1", start: "2026-11-09T10:00:00.000Z", end: "2026-11-09T11:00:00.000Z", capacity: 10, price: "18.00" },
      { id: "s2", title: "Later Yoga", classType: "yoga", instructorId: "i2", roomId: "r1", start: "2026-11-09T12:15:00.000Z", end: "2026-11-09T13:15:00.000Z", capacity: 10, price: "18.00" },
    ],
    customers: [
      { id: "c1", name: "Morning", email: "morning@example.com", prefs: { acceptsSubstitute: true, windows: [{ weekday: 1, from: "07:00", to: "11:00" }] } },
      { id: "c2", name: "Flexible", email: "flexible@example.com", prefs: { acceptsSubstitute: true, windows: Array.from({ length: 7 }, (_, weekday) => ({ weekday, from: "07:00", to: "21:00" })) } },
      { id: "c3", name: "Refund", email: "refund@example.com", prefs: { acceptsSubstitute: true, refundOnly: true, windows: [] } },
    ],
    bookings: ["c1", "c2", "c3"].map((customerId, index) => ({ id: `b${index + 1}`, customerId, sessionId: "s1", status: "confirmed", amount: "18.00" })),
  };
}
