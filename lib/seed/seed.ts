import type { ClassType, Customer, Disruption, Session, State } from "../domain/types";
import { addLocalDays, addMinutes, fitsPreferences, localParts, zonedTimeToUtc } from "../domain/time";

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = Math.imul(value ^ (value >>> 15), value | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

/** A reproducible boutique week. weekStart is normalized to its studio-local calendar day. */
export function seedStudio(seed = 42, weekStart = "2026-11-09T00:00:00-05:00"): State {
  const random = mulberry32(seed);
  const timezone = "America/New_York";
  const base = localParts(weekStart, timezone).dateKey;
  const state: State = {
    studio: {
      id: "studio-rebook", name: "Northstar Movement Studio", timezone, currency: "USD",
      openHours: Object.fromEntries(Array.from({ length: 7 }, (_, day) =>
        [day, [{ open: "07:00", close: day === 0 || day === 6 ? "13:00" : "21:00" }]])),
    },
    instructors: [
      { id: "instructor-01", name: "Maya Chen", skills: ["yoga", "dance", "barre"], maxSessionsPerDay: 3 },
      { id: "instructor-02", name: "Alex Rivera", skills: ["yoga", "pilates"], maxSessionsPerDay: 3 },
      { id: "instructor-03", name: "Sam Okafor", skills: ["spin", "hiit"], maxSessionsPerDay: 3 },
      { id: "instructor-04", name: "Jordan Lee", skills: ["yoga", "hiit"], maxSessionsPerDay: 3 },
      { id: "instructor-05", name: "Priya Shah", skills: ["pilates", "yoga"], maxSessionsPerDay: 3 },
      { id: "instructor-06", name: "Chris Morgan", skills: ["spin", "hiit", "pilates"], maxSessionsPerDay: 3 },
    ],
    rooms: [
      { id: "room-01", name: "Movement Hall", capacity: 14, supports: ["yoga", "dance", "barre"] },
      { id: "room-02", name: "Mat Studio", capacity: 12, supports: ["yoga", "pilates", "barre"] },
      { id: "room-03", name: "Cycle Lab", capacity: 12, supports: ["spin", "hiit"] },
      { id: "room-04", name: "Small Studio", capacity: 10, supports: ["yoga", "pilates", "hiit"] },
    ],
    sessions: [], customers: [], bookings: [],
  };
  const addSession = (day: number, clock: string, instructor: number, classType: ClassType, room: number) => {
    const space = state.rooms[room - 1];
    const start = zonedTimeToUtc(addLocalDays(base, day), clock, timezone);
    const session: Session = {
      id: `session-${String(state.sessions.length + 1).padStart(3, "0")}`,
      classType, title: `${classType[0].toUpperCase()}${classType.slice(1)} ${classType === "spin" ? "Ride" : "Flow"}`,
      instructorId: state.instructors[instructor - 1].id, roomId: space.id,
      start, end: addMinutes(start, 60), capacity: space.capacity,
      price: ["18.00", "22.00", "25.00"][Math.floor(random() * 3)],
    };
    state.sessions.push(session);
  };
  // Three Monday classes lead the demo: yoga has substitutes; dance/barre need Maya at a new time.
  addSession(0, "07:00", 1, "yoga", 1);
  addSession(0, "12:15", 1, "dance", 1);
  addSession(0, "18:45", 1, "barre", 1);
  const timetable: [string, number, ClassType, number][][] = [
    [["08:15", 3, "spin", 3], ["09:30", 5, "pilates", 2], ["12:15", 6, "hiit", 3],
      ["17:30", 4, "yoga", 1], ["17:30", 2, "pilates", 2]],
    [["07:00", 2, "yoga", 1], ["08:15", 3, "spin", 3], ["09:30", 5, "pilates", 2],
      ["12:15", 4, "hiit", 3], ["12:15", 2, "yoga", 2], ["17:30", 1, "barre", 1],
      ["17:30", 6, "spin", 3], ["18:45", 5, "pilates", 2]],
    [["07:00", 1, "yoga", 1], ["08:15", 3, "spin", 3], ["09:30", 2, "pilates", 2],
      ["12:15", 1, "dance", 1], ["12:15", 6, "hiit", 3], ["17:30", 4, "yoga", 1],
      ["17:30", 5, "pilates", 2], ["18:45", 3, "hiit", 3]],
    [["07:00", 1, "barre", 1], ["08:15", 6, "spin", 3], ["09:30", 5, "pilates", 2],
      ["12:15", 2, "yoga", 1], ["12:15", 4, "hiit", 3], ["17:30", 1, "yoga", 1],
      ["17:30", 3, "spin", 3], ["18:45", 6, "pilates", 2]],
    [["07:00", 4, "yoga", 1], ["08:15", 3, "spin", 3], ["09:30", 2, "pilates", 2],
      ["12:15", 5, "yoga", 1], ["12:15", 6, "hiit", 3], ["17:30", 1, "dance", 1],
      ["17:30", 2, "pilates", 2], ["18:45", 4, "hiit", 3]],
    [["07:00", 4, "yoga", 1], ["08:15", 3, "spin", 3], ["09:30", 1, "yoga", 1], ["10:45", 1, "dance", 1]],
    [["07:00", 5, "yoga", 1], ["08:15", 6, "spin", 3], ["09:30", 1, "barre", 1], ["10:45", 2, "pilates", 2]],
  ];
  timetable.forEach((day, index) => day.forEach(([clock, instructor, type, room]) => addSession(index, clock, instructor, type, room)));

  const names = ["Avery", "Blake", "Casey", "Drew", "Emery", "Finley", "Gray", "Harper", "Indigo", "Jules",
    "Kai", "Logan", "Morgan", "Noel", "Oakley", "Parker", "Quinn", "Reese", "Sage", "Taylor",
    "Uma", "Val", "Wren", "Xan", "Yael", "Zion", "Arden", "Briar", "Cameron", "Devon",
    "Ellis", "Frankie", "Georgie", "Hayden", "Jamie", "Kendall", "Lane", "Micah", "Nico", "Rowan"];
  const windows = (days: number[], from: string, to: string): Customer["prefs"]["windows"] =>
    days.map((weekday) => ({ weekday, from, to }));
  for (let index = 0; index < 40; index += 1) {
    const loyal = index < 6;
    let preferences: Customer["prefs"]["windows"];
    if (index < 9) preferences = [
      ...windows([1, 2], "07:00", "20:00"), ...windows([4, 6], "07:00", "13:00"),
    ];
    else if (index < 19) preferences = windows([1, 2, 4, 6], "07:00", "12:00");
    else if (index < 29) preferences = windows([1, 2, 3, 5], "12:00", "14:00");
    else preferences = [...windows([1, 2, 4], "17:00", "20:00"), ...windows([0], "07:00", "12:00")];
    if (index >= 24 && index < 29) preferences = windows([1, 2, 4, 5], "12:00", "14:00");
    if (index >= 34 && index < 39) preferences = [...windows([1, 3, 5], "17:00", "20:00"), ...windows([0], "07:00", "12:00")];
    if (index === 39) preferences = [...windows([1], "12:00", "14:00"), ...windows([3, 5], "17:00", "20:00")];
    // Additional morning members cover Wednesday/Friday without all-day preferences.
    if (index >= 14 && index < 19) preferences = windows([1, 3, 5, 6], "07:00", "12:00");
    state.customers.push({
      id: `customer-${String(index + 1).padStart(3, "0")}`, name: `${names[index]} Brooks`,
      email: `member${index + 1}@example.com`,
      prefs: { windows: preferences, acceptsSubstitute: !loyal,
        ...(loyal ? { preferredInstructorIds: ["instructor-01"] } : {}),
        ...(index >= 6 && index < 9 ? { refundOnly: true } : {}),
      },
    });
  }
  const heroMembers = [
    [0, 6, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    [7, 19, 20, 21, 22, 23, 24, 25, 26, 39],
    [8, 29, 30, 31, 32, 33, 0, 1, 2, 3],
  ];
  for (const [sessionIndex, session] of state.sessions.entries()) {
    const eligible = state.customers.filter((customer) => fitsPreferences(customer, session.start, session.end, timezone) &&
      (customer.prefs.acceptsSubstitute || customer.prefs.preferredInstructorIds?.includes(session.instructorId)));
    // Fisher-Yates keeps selection deterministic and avoids duplicate bookings in a class.
    for (let index = eligible.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [eligible[index], eligible[other]] = [eligible[other], eligible[index]];
    }
    const count = Math.min(4 + Math.floor(random() * 9), session.capacity, eligible.length);
    const members = sessionIndex < 3 ? heroMembers[sessionIndex].map((index) => state.customers[index]) : eligible.slice(0, count);
    for (const customer of members) {
      const suffix = String(state.bookings.length + 1).padStart(4, "0");
      state.bookings.push({
        id: `booking-${suffix}`, sessionId: session.id, customerId: customer.id, status: "confirmed", amount: session.price,
        payment: { orderId: `SEED-ORDER-${suffix}`, captureId: `SEED-CAP-${suffix}` },
      });
    }
  }
  return state;
}

/** These disruptions match seedStudio()'s default studio-local week. */
export const demoDisruption: Disruption = {
  kind: "instructor_unavailable", instructorId: "instructor-01",
  from: zonedTimeToUtc("2026-11-09", "00:00", "America/New_York"),
  to: zonedTimeToUtc("2026-11-10", "00:00", "America/New_York"),
  reason: "Maya is sick and cannot teach Monday's classes.",
};

export const floodDisruption: Disruption = {
  kind: "room_unavailable", roomId: "room-01",
  from: zonedTimeToUtc("2026-11-11", "16:00", "America/New_York"),
  to: zonedTimeToUtc("2026-11-11", "21:00", "America/New_York"),
  reason: "A leak closes Movement Hall on Wednesday evening.",
};
