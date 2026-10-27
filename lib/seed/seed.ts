import type { ClassType, Customer, Disruption, Session, State } from "../domain/types";
import { addLocalDays, addMinutes, fitsPreferences, localParts, overlaps, zonedTimeToUtc } from "../domain/time";

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = Math.imul(value ^ (value >>> 15), value | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

/** Local midnight on the next Monday, strictly after today's local date. */
export function nextWeekStart(nowIso: string, tz: string): string {
  const today = localParts(nowIso, tz);
  return zonedTimeToUtc(addLocalDays(today.dateKey, (8 - today.weekday) % 7 || 7), "00:00", tz);
}

/** A reproducible boutique week. weekStart is normalized to its studio-local calendar day. */
export function seedStudio(seed = 42, weekStart = "2026-11-09T00:00:00-05:00"): State {
  const random = mulberry32(seed);
  const timezone = "America/New_York";
  const base = localParts(weekStart, timezone).dateKey;
  const state: State = {
    studio: {
      id: "studio-rebook", name: "Northstar Movement Studio", timezone, currency: "USD",
      weekStart: zonedTimeToUtc(base, "00:00", timezone),
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
  // A full boutique timetable, with Tuesday space for Maya's recovery classes.
  // Wednesday has one Movement Hall class in the flood window, keeping real captures bounded.
  const timetable: [string, number, ClassType, number][][] = [
    [["08:15", 3, "spin", 3], ["09:30", 5, "pilates", 2],
      ["17:30", 2, "pilates", 2], ["17:30", 4, "hiit", 3]],
    [["07:00", 2, "yoga", 1], ["08:15", 3, "spin", 3], ["09:30", 5, "pilates", 2],
      ["12:15", 4, "hiit", 3], ["17:30", 6, "pilates", 2], ["17:30", 3, "spin", 3], ["18:45", 5, "pilates", 2]],
    [["07:00", 4, "hiit", 3], ["08:15", 3, "spin", 3], ["09:30", 2, "pilates", 2],
      ["12:15", 6, "hiit", 3], ["17:30", 4, "yoga", 1], ["17:30", 5, "pilates", 2], ["18:45", 6, "spin", 3]],
    [["07:00", 1, "yoga", 1], ["08:15", 3, "spin", 3], ["09:30", 2, "pilates", 2],
      ["12:15", 6, "hiit", 3], ["17:30", 5, "pilates", 2], ["17:30", 4, "hiit", 3], ["18:45", 1, "barre", 1]],
    [["07:00", 4, "yoga", 1], ["08:15", 6, "spin", 3], ["09:30", 2, "pilates", 2],
      ["12:15", 1, "dance", 1], ["17:30", 4, "hiit", 3], ["17:30", 5, "pilates", 2], ["18:45", 3, "spin", 3]],
    [["07:00", 3, "spin", 3], ["08:15", 5, "pilates", 2], ["09:30", 1, "yoga", 1], ["10:45", 6, "hiit", 3]],
    [["08:15", 2, "pilates", 2], ["09:30", 4, "yoga", 1], ["10:45", 6, "spin", 3]],
  ];
  timetable.forEach((day, index) => day.forEach(([clock, instructor, type, room]) => addSession(index, clock, instructor, type, room)));

  const names = ["Avery", "Blake", "Casey", "Drew", "Emery", "Finley", "Gray", "Harper", "Indigo", "Jules",
    "Kai", "Logan", "Morgan", "Noel", "Oakley", "Parker", "Quinn", "Reese", "Sage", "Taylor",
    "Uma", "Val", "Wren", "Xan", "Yael", "Zion", "Arden", "Briar", "Cameron", "Devon",
    "Ellis", "Frankie", "Georgie", "Hayden", "Jamie", "Kendall", "Lane", "Micah", "Nico", "Rowan"];
  const windows = (days: number[], from: string, to: string): Customer["prefs"]["windows"] =>
    days.map((weekday) => ({ weekday, from, to }));
  for (let index = 0; index < 120; index += 1) {
    const loyal = index < 6;
    let preferences: Customer["prefs"]["windows"];
    if (index < 9) preferences = [
      ...windows([1, 2, 4], "07:00", "20:00"), ...windows([6], "07:00", "13:00"),
    ];
    else if (index < 19) preferences = windows([1, 2, 4, 6], "07:00", "12:00");
    else if (index < 29) preferences = windows([1, 2, 3, 5], "12:00", "14:00");
    else preferences = [...windows([1, 2, 4], "17:00", "20:00"), ...windows([0], "07:00", "12:00")];
    if (index >= 24 && index < 29) preferences = windows([1, 2, 4, 5], "12:00", "14:00");
    if (index >= 34 && index < 39) preferences = [...windows([2, 3, 5], "17:00", "20:00"), ...windows([0], "07:00", "12:00")];
    if (index === 33) preferences = [...windows([1, 2, 3], "17:00", "20:00"), ...windows([0], "07:00", "12:00")];
    if (index === 39) preferences = [...windows([1], "12:00", "14:00"), ...windows([3, 5], "17:00", "20:00")];
    // Additional morning members cover Wednesday/Friday without all-day preferences.
    if (index >= 14 && index < 19) preferences = windows([1, 3, 5, 6], "07:00", "12:00");
    if (index === 12) preferences = windows([1, 2, 5, 6], "07:00", "12:00");
    if (index === 13) preferences = windows([1, 2, 3, 6], "07:00", "12:00");
    if (index >= 40) {
      // Weekend members can also attend Sunday if a Saturday class must move.
      const days = [[1, 2, 6, 0], [1, 3, 5, 0], [2, 4, 6, 0], [2, 4, 5, 0]][index % 4];
      const [from, to] = index < 72 ? ["07:00", "12:00"] : index < 84 ? ["12:00", "14:00"] :
        index < 108 ? ["17:00", "20:00"] : ["07:00", "20:00"];
      preferences = days.map((weekday) => ({ weekday,
        from: weekday === 0 || weekday === 6 ? "07:00" : from,
        to: weekday === 0 || weekday === 6 ? "13:00" : to,
      }));
    }
    state.customers.push({
      id: `customer-${String(index + 1).padStart(3, "0")}`, name: `${names[index % names.length]} ${["Brooks", "Patel", "Reed"][Math.floor(index / names.length)]}`,
      email: `member${index + 1}@example.com`,
      prefs: { windows: preferences, acceptsSubstitute: !loyal,
        ...(loyal ? { preferredInstructorIds: ["instructor-01"] } : {}),
        ...(index >= 6 && index < 9 ? { refundOnly: true } : {}),
      },
    });
  }
  const heroMembers = [
    [0, 6, 9, 10, 11, 12, 13, 14, 15, 16, 17],
    [7, 19, 20, 21, 22, 23, 24, 25, 26, 39],
    [8, 29, 30, 31, 32, 33, 0, 1, 2, 3],
  ];
  // Tuesday regulars differ from Monday's dance/barre members. Taylor (index 19)
  // attends both Monday dance and Tuesday lunchtime HIIT, leaving one recovery clash.
  const tuesdayMembers: Record<string, number[]> = {
    "12:15": [6, 7, 8, 19, 27, 28],
    "18:45": [6, 7, 8, 34, 35, 36, 37, 38],
  };
  const regularIds = new Set(state.customers.slice(0, 4).map(({ id }) => id));
  const bookingCounts = new Map<string, number>();
  for (const [sessionIndex, session] of state.sessions.entries()) {
    const eligible = state.customers.filter((customer) => fitsPreferences(customer, session.start, session.end, timezone) &&
      (customer.prefs.acceptsSubstitute || customer.prefs.preferredInstructorIds?.includes(session.instructorId)) &&
      (bookingCounts.get(customer.id) ?? 0) < 5 &&
      !state.bookings.some((booking) => booking.customerId === customer.id && state.sessions.some((other) =>
        other.id === booking.sessionId && overlaps(session.start, session.end, other.start, other.end))));
    // Fisher-Yates keeps selection deterministic and avoids duplicate bookings in a class.
    for (let index = eligible.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [eligible[index], eligible[other]] = [eligible[other], eligible[index]];
    }
    // Four Maya regulars attend four or five times; spread other visits across the membership.
    eligible.sort((a, b) => Number(regularIds.has(b.id)) - Number(regularIds.has(a.id)) ||
      (bookingCounts.get(a.id) ?? 0) - (bookingCounts.get(b.id) ?? 0));
    const count = Math.min(Math.ceil(session.capacity * 0.5) + (random() > 0.8 ? 1 : 0), eligible.length);
    const local = localParts(session.start, timezone);
    const clock = `${String(Math.floor(local.minutesOfDay / 60)).padStart(2, "0")}:${String(local.minutesOfDay % 60).padStart(2, "0")}`;
    const roster = sessionIndex < 3 ? heroMembers[sessionIndex] : local.weekday === 2 ? tuesdayMembers[clock] : undefined;
    const members = roster ? roster.map((index) => state.customers[index]) : eligible.slice(0, count);
    for (const customer of members) {
      const suffix = String(state.bookings.length + 1).padStart(4, "0");
      state.bookings.push({
        id: `booking-${suffix}`, sessionId: session.id, customerId: customer.id, status: "confirmed", amount: session.price,
        bookedAt: addMinutes(state.studio.weekStart, -7 * 24 * 60 + state.bookings.length),
        payment: { orderId: `SEED-ORDER-${suffix}`, captureId: `SEED-CAP-${suffix}` },
      });
      bookingCounts.set(customer.id, (bookingCounts.get(customer.id) ?? 0) + 1);
    }
  }
  // Recovery choices recorded after the ordinary week was booked: Avery now accepts
  // cover, while Logan, Taylor and Uma prefer refunds after any disruption.
  // Along with Gray, Harper and Indigo, these are the six genuine Monday refunds.
  state.customers[0].prefs.acceptsSubstitute = true;
  for (const index of [11, 19, 20]) state.customers[index].prefs.refundOnly = true;
  // Devon can make Tuesday lunch, so availability no longer forces a demo refund.
  state.customers[39].prefs.windows.push({ weekday: 2, from: "12:15", to: "13:15" });
  return state;
}

/** Scenario windows follow the seeded studio-local week. */
export function demoDisruptionFor(weekStart: string, tz: string): Disruption {
  const date = localParts(weekStart, tz).dateKey;
  return {
    kind: "instructor_unavailable", instructorId: "instructor-01",
    from: zonedTimeToUtc(date, "00:00", tz),
    to: zonedTimeToUtc(addLocalDays(date, 1), "00:00", tz),
    reason: "Maya is sick and cannot teach Monday's classes.",
  };
}

export function floodDisruptionFor(weekStart: string, tz: string): Disruption {
  const date = addLocalDays(localParts(weekStart, tz).dateKey, 2);
  return {
    kind: "room_unavailable", roomId: "room-01",
    from: zonedTimeToUtc(date, "16:00", tz),
    to: zonedTimeToUtc(date, "21:00", tz),
    reason: "A leak closes Movement Hall on Wednesday evening.",
  };
}

// Preserve the original reproducible fixtures for callers that do not select a week.
export const demoDisruption = demoDisruptionFor("2026-11-09T00:00:00-05:00", "America/New_York");
export const floodDisruption = floodDisruptionFor("2026-11-09T00:00:00-05:00", "America/New_York");
