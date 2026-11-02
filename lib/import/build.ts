import type { Booking, ClassType, Customer, Instructor, Room, Session, State, WaitlistEntry } from "../domain/types";
import { StateSchema } from "../domain/schemas";
import { addLocalDays, fromCents, localParts, zonedTimeToUtc } from "../domain/time";
import { nextWeekStart } from "../seed/seed";
import { feasibilityErrors } from "../solver/validate";
import { parseCsv } from "./csv";
import { paymentEntitlement, REQUIRED_FIELDS, type ColumnMapping, type ImportField } from "./fields";

export const IMPORT_LIMITS = { bytes: 512 * 1024, rows: 3000, classes: 400 };
export type ImportInput = { mapping: ColumnMapping; classTypes: Record<string, ClassType>; timezone: string; studioName?: string; dateOrder?: "mdy" | "dmy" };
export type ImportSummary = { classes: number; instructors: number; rooms: number; customers: number; bookings: number; weekOf?: string; shiftedWeeks: number };
export type ImportResult = { state?: State; summary: ImportSummary; errors: string[]; warnings: string[]; dateOrder?: { value: "mdy" | "dmy"; ambiguous: boolean } };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (value: number) => String(value).padStart(2, "0");
const key = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? `${year}-${pad(month)}-${pad(day)}` : undefined;
};
/** ISO, month/day/year (day/month/year when the first number is over 12) or "Nov 9 2026" / "9 Nov 2026" -> YYYY-MM-DD. */
export function parseDate(value: string): string | undefined {
  return readDate(value);
}
function readDate(value: string, order?: "mdy" | "dmy"): string | undefined {
  const text = value.trim();
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return key(+match[1], +match[2], +match[3]);
  match = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
  if (match) {
    const year = +match[3] < 100 ? 2000 + +match[3] : +match[3];
    return order === "dmy" || (!order && +match[1] > 12) ? key(year, +match[2], +match[1]) : key(year, +match[1], +match[2]);
  }
  const words = text.toLowerCase().replace(/,/g, " ").split(/\s+/);
  const month = words.findIndex((word) => MONTHS.includes(word.slice(0, 3)) && /^[a-z]+\.?$/.test(word));
  const numbers = words.filter((word) => /^\d{1,4}(st|nd|rd|th)?$/.test(word)).map((word) => parseInt(word, 10));
  const year = numbers.find((item) => item > 31), day = numbers.find((item) => item >= 1 && item <= 31);
  return month >= 0 && year && day ? key(year, MONTHS.indexOf(words[month].slice(0, 3)) + 1, day) : undefined;
}
/** "7:00", "07:00", "7:00 AM", "7am", "7.30pm", "19:30", or the time part of a date-time -> minutes after midnight. */
export function parseClock(value: string): number | undefined {
  const match = value.trim().match(/(?:^|[\sT])(\d{1,2})(?:[:.h](\d{2}))?(?::\d{2}(?:\.\d+)?)?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:Z|[+-]\d{2}:?\d{2})?$/i);
  if (!match) return undefined;
  let hours = +match[1];
  const minutes = match[2] ? +match[2] : 0, meridiem = match[3]?.toLowerCase()[0];
  if (!match[2] && !meridiem) return undefined;
  if (meridiem) { if (hours < 1 || hours > 12) return undefined; hours = hours % 12 + (meridiem === "p" ? 12 : 0); }
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
}
const clock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const money = (value: string) => {
  const match = value.trim().match(/^(?:\$\s*|USD\s+)?(\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.(\d{1,2}))?(?:\s+USD)?$/);
  if (!match) return undefined;
  const cents = Number(match[1].replace(/,/g, "")) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents < 10_000_000 ? fromCents(cents) : undefined;
};
const hasOffset = (value: string) => /^\d{4}-\d{1,2}-\d{1,2}[T\s].*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
function instantParts(value: string, tz: string) {
  if (!hasOffset(value) || !parseDate(value) || parseClock(value) === undefined || !Number.isFinite(Date.parse(value))) return undefined;
  return localParts(new Date(value).toISOString(), tz);
}
const slug = (prefix: string, index: number) => `${prefix}-${pad(index + 1)}`;
export function validTimeZone(timezone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); return true; } catch { return false; }
}

/** Build a private studio week from a booking export. Errors block creation; warnings explain every assumption. */
export function buildImport(csv: string, input: ImportInput, now = new Date()): ImportResult {
  const errors: string[] = [], warnings: string[] = [];
  const summary: ImportSummary = { classes: 0, instructors: 0, rooms: 0, customers: 0, bookings: 0, shiftedWeeks: 0 };
  const fail = (message: string): ImportResult => ({ summary, errors: [message], warnings });
  if (new TextEncoder().encode(csv).byteLength > IMPORT_LIMITS.bytes) return fail("The file is larger than 512 KB. Export one week at a time.");
  if (!validTimeZone(input.timezone)) return fail("Choose your studio's time zone.");
  const [headers, ...rows] = parseCsv(csv);
  if (!headers || !rows.length) return fail("The file has no rows under its header line.");
  if (rows.length > IMPORT_LIMITS.rows) return fail(`The file has ${rows.length} rows; the limit is ${IMPORT_LIMITS.rows}. Export one week at a time.`);
  const missing = REQUIRED_FIELDS.filter((field) => !input.mapping[field] || !headers.includes(input.mapping[field]!));
  if (missing.length) return fail(`Choose a column for: ${missing.join(", ").replace(/_/g, " ")}.`);
  if (!input.mapping.date && !rows.some((row) => { const value = row[headers.indexOf(input.mapping.start!)] ?? ""; return parseDate(value) || hasOffset(value); })) return fail("Choose a date column, or a start column that includes the date.");
  const tz = input.timezone;
  const cell = (row: string[], field: ImportField) => { const header = input.mapping[field]; return header ? row[headers.indexOf(header)]?.trim() ?? "" : ""; };
  const rowError = (line: number, message: string) => { if (errors.length < 20) errors.push(`Row ${line}: ${message}`); else if (errors.length === 20) errors.push("More rows have problems; fix these first."); };
  const numericDates = rows.flatMap((row, index) => [...new Set([cell(row, "date") || cell(row, "start"), cell(row, "end"),
    ...(paymentEntitlement(cell(row, "payment"))?.kind === "pack" ? [cell(row, "expires")] : [])])].flatMap((value) => {
    const match = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}\b/);
    return match ? [{ first: +match[1], second: +match[2], value, line: index + 2 }] : [];
  }));
  const dmy = numericDates.find((date) => date.first > 12 && date.second <= 12), mdy = numericDates.find((date) => date.second > 12 && date.first <= 12);
  if (dmy && mdy) return fail(`Row ${dmy.line}: "${dmy.value}" uses day/month, but row ${mdy.line}: "${mdy.value}" uses month/day. Use one date order throughout the file.`);
  const dateOrder = { value: dmy ? "dmy" as const : mdy ? "mdy" as const : input.dateOrder ?? "mdy", ambiguous: numericDates.length > 0 && !dmy && !mdy };
  if (dateOrder.ambiguous) warnings.push(`Dates like 09/11/2026 were read as ${dateOrder.value === "mdy" ? "month/day (Sep 11)" : "day/month (9 Nov)"}. Change "Dates are written as" if your export uses ${dateOrder.value === "mdy" ? "day/month" : "month/day"}.`);

  type Draft = { title: string; type: ClassType; date: string; start: number; end: number; startInstant?: string; endInstant?: string; instructor: string; room: string; capacity?: number; price?: string; line: number };
  const classes = new Map<string, Draft>(), people = new Map<string, { name: string; accepts?: boolean }>();
  const seats: { classKey: string; email: string; price?: string; entitlement?: Booking["entitlement"]; waitlisted?: boolean; line: number }[] = [];
  let assumedDuration = false, assumedRoom = false, ignoredPackFields = false;
  const untyped = new Map<string, number>();
  const omitted = { cancelled: 0, removed: 0 }, unknownStatuses = new Set<string>();
  rows.forEach((row, index) => {
    const line = index + 2, title = cell(row, "class"), instructor = cell(row, "instructor");
    if (!title) return rowError(line, "no class name.");
    if (!instructor) return rowError(line, `no instructor for ${title}.`);
    const type = input.classTypes[title];
    if (!type) { untyped.set(title, (untyped.get(title) ?? 0) + 1); return; }
    const startCell = cell(row, "start"), endCell = cell(row, "end");
    const startParts = instantParts(startCell, tz), endParts = instantParts(endCell, tz);
    if (hasOffset(startCell) && !startParts) return rowError(line, `can't read the start time "${startCell}".`);
    if (hasOffset(endCell) && !endParts) return rowError(line, `can't read the end time "${endCell}".`);
    if ((startParts && !Number.isInteger(startParts.minutesOfDay)) || (endParts && !Number.isInteger(endParts.minutesOfDay))) return rowError(line, "date-times must use whole minutes; seconds would be lost.");
    const date = startParts?.dateKey ?? readDate(cell(row, "date") || startCell, dateOrder.value);
    if (!date) return rowError(line, `can't read the date "${cell(row, "date") || cell(row, "start")}".`);
    const start = startParts?.minutesOfDay ?? parseClock(startCell);
    if (start === undefined) return rowError(line, `can't read the start time "${cell(row, "start")}".`);
    let end = endParts?.minutesOfDay ?? (endCell ? parseClock(endCell) : undefined);
    const minutes = Number(cell(row, "duration").replace(/[^0-9.]/g, ""));
    if (end === undefined && cell(row, "end")) return rowError(line, `can't read the end time "${cell(row, "end")}".`);
    if (end === undefined) { end = start + (minutes > 0 && minutes <= 240 ? Math.round(minutes) : 60); if (!(minutes > 0)) assumedDuration = true; }
    if (end <= start || end > 24 * 60 || (endParts && endParts.dateKey !== date)) return rowError(line, `${title} must end after it starts, on the same day.`);
    const room = cell(row, "room") || "Main studio";
    if (!cell(row, "room")) assumedRoom = true;
    const capacity = parseInt(cell(row, "capacity"), 10);
    const entitlement = paymentEntitlement(cell(row, "payment"));
    const visits = cell(row, "visitsLeft"), expiry = cell(row, "expires");
    if (entitlement?.kind === "pack") {
      if (visits && (!/^\d+$/.test(visits) || !Number.isSafeInteger(Number(visits)))) return rowError(line, `Visits left must be a non-negative integer, not "${visits}".`);
      const expires = expiry ? readDate(expiry, dateOrder.value) : undefined;
      if (expiry && !expires) return rowError(line, `can't read the pack expiry "${expiry}".`);
      if (visits) entitlement.visitsLeft = Number(visits);
      if (expires) entitlement.expires = expires;
    } else if (visits || expiry) ignoredPackFields = true;
    const price = entitlement ? undefined : money(cell(row, "price"));
    if (!entitlement && cell(row, "price") && price === undefined) return rowError(line, `can't read the price "${cell(row, "price")}". Rebook reads US dollars only; use a non-negative amount like 20.00 or $20.00.`);
    const classKey = [title, date, start, instructor.toLowerCase(), room.toLowerCase()].join("|");
    const draft = classes.get(classKey) ?? { title, type, date, start, end, startInstant: startParts ? new Date(startCell).toISOString() : undefined, endInstant: endParts ? new Date(endCell).toISOString() : undefined, instructor, room, line };
    if (capacity > 0 && capacity <= 500) draft.capacity = Math.max(draft.capacity ?? 0, capacity);
    draft.price ??= price;
    classes.set(classKey, draft);
    const status = cell(row, "status").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    if (/^(cancelled|canceled|late cancel|late cancelled|late canceled|late cancellation)$/.test(status)) { omitted.cancelled++; return; }
    const waitlisted = /^(waitlist|waitlisted|wait list|wait listed)$/.test(status);
    if (status === "removed") { omitted.removed++; return; }
    if (status && !waitlisted && !/^(booked|confirmed|attended|present|checked in|completed|no show)$/.test(status)) unknownStatuses.add(status);
    const email = cell(row, "customer_email").toLowerCase(), name = cell(row, "customer_name");
    if (!email && !name) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return rowError(line, name ? `${name} has no valid email address.` : `"${email}" is not an email address.`);
    const accepts = cell(row, "accepts_substitute").toLowerCase();
    const person = people.get(email) ?? { name: name || email.split("@")[0] };
    if (/^(n|no|false|0)$/.test(accepts)) person.accepts = false;
    else if (/^(y|yes|true|1)$/.test(accepts) && person.accepts === undefined) person.accepts = true;
    people.set(email, person);
    seats.push({ classKey, email, price, entitlement, waitlisted, line });
  });
  // One line per class, not per booking row.
  errors.unshift(...[...untyped].map(([title, count]) => `Choose a class type for "${title}" (${count} ${count === 1 ? "row" : "rows"}).`));
  if (classes.size > IMPORT_LIMITS.classes) return fail(`The file has ${classes.size} classes; the limit is ${IMPORT_LIMITS.classes}. Export one week at a time.`);
  if (!classes.size) return { summary, errors: errors.length ? errors : ["No classes found."], warnings, dateOrder };
  const exclusions = Object.entries(omitted).filter(([, count]) => count).map(([status, count]) => `${count} ${status}`);
  if (exclusions.length) warnings.push(`Left out ${exclusions.join(" and ")} rows: they are not bookings.`);
  if (unknownStatuses.size) warnings.push(`Unrecognized booking statuses were counted as bookings: ${[...unknownStatuses].slice(0, 5).map((status) => `"${status}"`).join(", ")}${unknownStatuses.size > 5 ? ", and more" : ""}.`);

  // One studio week, Monday to Sunday. A past week moves forward to the coming week so it can be re-planned.
  const drafts = [...classes.values()].sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
  const monday = (date: string) => addLocalDays(date, -((localParts(zonedTimeToUtc(date, "12:00", tz), tz).weekday + 6) % 7));
  const weekOf = monday(drafts[0].date);
  const outside = drafts.find((draft) => draft.date >= addLocalDays(weekOf, 7));
  if (outside) return { summary, errors: [...errors, `Row ${outside.line}: ${outside.date} is outside the week of ${weekOf}. Import one week at a time.`], warnings, dateOrder };
  let shift = 0;
  if (Date.parse(zonedTimeToUtc(drafts[0].date, clock(drafts[0].start), tz)) <= now.getTime()) {
    const target = localParts(nextWeekStart(now.toISOString(), tz), tz).dateKey;
    shift = Math.round((Date.parse(target) - Date.parse(weekOf)) / 86_400_000);
    summary.shiftedWeeks = shift / 7;
    warnings.push(`Moved the week of ${weekOf} to the week of ${target} so you can plan ahead. Weekdays and times are unchanged.`);
  }
  summary.weekOf = addLocalDays(weekOf, shift);

  const instructorNames = [...new Map(drafts.map((draft) => [draft.instructor.toLowerCase(), draft.instructor])).values()];
  const roomNames = [...new Map(drafts.map((draft) => [draft.room.toLowerCase(), draft.room])).values()];
  const instructorId = new Map(instructorNames.map((name, index) => [name.toLowerCase(), slug("instructor", index)]));
  const roomId = new Map(roomNames.map((name, index) => [name.toLowerCase(), slug("room", index)]));
  const booked = new Map<string, number>();
  for (const seat of seats.filter((seat) => !seat.waitlisted)) booked.set(seat.classKey, (booked.get(seat.classKey) ?? 0) + 1);
  let assumedCapacity = false, assumedPrice = false;
  const sessionId = new Map<string, string>();
  let raisedCapacity = 0;
  const sessions: Session[] = drafts.map((draft, index) => {
    const id = slug("session", index), date = addLocalDays(draft.date, shift);
    const classKey = [draft.title, draft.date, draft.start, draft.instructor.toLowerCase(), draft.room.toLowerCase()].join("|");
    sessionId.set(classKey, id);
    if (!draft.capacity) assumedCapacity = true;
    if (!draft.price) assumedPrice = true;
    const capacity = Math.max(draft.capacity ?? 12, booked.get(classKey) ?? 0);
    if (capacity > (draft.capacity ?? 12)) {
      if (raisedCapacity < 5) warnings.push(`Row ${draft.line}: ${draft.title} has more bookings than its capacity; capacity raised to ${capacity}.`);
      raisedCapacity++;
    }
    return { id, title: draft.title, classType: draft.type, instructorId: instructorId.get(draft.instructor.toLowerCase())!, roomId: roomId.get(draft.room.toLowerCase())!,
      start: !shift && draft.startInstant ? draft.startInstant : zonedTimeToUtc(date, clock(draft.start), tz), end: !shift && draft.endInstant ? draft.endInstant : zonedTimeToUtc(date, clock(draft.end), tz),
      capacity, price: draft.price ?? "20.00" };
  });
  if (raisedCapacity > 5) warnings[warnings.length - 1] = warnings[warnings.length - 1].replace(/\.$/, "; and more.");
  const instructors: Instructor[] = instructorNames.map((name) => {
    const id = instructorId.get(name.toLowerCase())!, mine = sessions.filter((session) => session.instructorId === id);
    const perDay = Math.max(...Object.values(Object.groupBy(mine, (session) => localParts(session.start, tz).dateKey)).map((items) => items?.length ?? 0));
    return { id, name, skills: [...new Set(mine.map((session) => session.classType))], maxSessionsPerDay: Math.max(3, perDay) };
  });
  const rooms: Room[] = roomNames.map((name) => {
    const id = roomId.get(name.toLowerCase())!, held = sessions.filter((session) => session.roomId === id);
    return { id, name, capacity: Math.max(...held.map((session) => session.capacity)), supports: [...new Set(held.map((session) => session.classType))] };
  });
  const emails = [...people.keys()];
  const customers: Customer[] = emails.map((email, index) => ({ id: slug("customer", index), name: people.get(email)!.name, email,
    prefs: { acceptsSubstitute: people.get(email)!.accepts ?? true, availabilityKnown: false,
      windows: Array.from({ length: 7 }, (_, weekday) => ({ weekday, from: "00:00", to: "23:59" })) } }));
  const customerId = new Map(emails.map((email, index) => [email, customers[index].id]));
  const seen = new Set<string>(), bookings: Booking[] = [], waitlist: WaitlistEntry[] = [];
  for (const seat of seats) {
    const session = sessionId.get(seat.classKey), customer = customerId.get(seat.email);
    if (!session || !customer) continue;
    if (seat.waitlisted) {
      if (!waitlist.some((entry) => entry.sessionId === session && entry.customerId === customer)) waitlist.push({ id: slug("waitlist", waitlist.length), sessionId: session, customerId: customer,
        joinedAt: new Date(now.getTime() - 86_400_000 + seat.line * 1000).toISOString(), ...(seat.entitlement ? { entitlement: seat.entitlement } : {}) });
      continue;
    }
    if (seen.has(`${session}|${customer}`)) { warnings.push(`Row ${seat.line}: a repeated booking for the same person and class was counted once.`); continue; }
    seen.add(`${session}|${customer}`);
    const id = slug("booking", bookings.length), price = seat.price ?? sessions.find((item) => item.id === session)!.price;
    bookings.push({ id, sessionId: session, customerId: customer, status: "confirmed", amount: seat.entitlement ? "0.00" : price, bookedAt: new Date(now.getTime() - 86_400_000 + bookings.length * 1000).toISOString(),
      ...(seat.entitlement ? { entitlement: seat.entitlement } : { payment: { orderId: `IMPORT-ORDER-${id}`, captureId: `IMPORT-CAP-${id}`, simulated: true } }) });
  }
  if (waitlist.length) warnings.push(`${seats.filter((seat) => seat.waitlisted).length} waitlisted rows joined their class waitlists.`);
  const packs = bookings.filter((booking) => booking.entitlement?.kind === "pack").length;
  const memberships = bookings.filter((booking) => booking.entitlement?.kind === "membership").length;
  if (packs || memberships) warnings.push(bookings.some((booking) => booking.entitlement?.visitsLeft !== undefined)
    ? `${packs} bookings use a class pack and ${memberships} a membership: Rebook returns visits instead of refunding cash. Imported pack balances and returned visits are tracked; export the balance changes to apply in your booking system.`
    : `${packs} bookings use a class pack and ${memberships} a membership: Rebook returns visits instead of refunding cash, and your booking system keeps the balances.`);
  if (ignoredPackFields) warnings.push("Visits left and pack expiry were ignored on cash or membership rows; these fields apply only to packs.");
  const first = Math.min(...drafts.map((draft) => draft.start)), last = Math.max(...drafts.map((draft) => draft.end));
  const weekdays = [...new Set(sessions.map((session) => localParts(session.start, tz).weekday))].sort((a, b) => (a + 6) % 7 - (b + 6) % 7);
  const openHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, weekdays.includes(day) ? [{ open: clock(first), close: clock(last) }] : []]));
  warnings.push(`Opening hours aren't in the export: Rebook assumes you open ${weekdays.map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ")} from ${clock(first)} to ${clock(last)}, when your classes run.`);
  warnings.push("Instructors are assumed to teach only the class types they teach this week, and to be free whenever they are not teaching.");
  const state: State = { studio: { id: "studio", name: input.studioName?.trim().slice(0, 80) || "Your studio", timezone: tz,
    weekStart: zonedTimeToUtc(summary.weekOf, "00:00", tz), openHours, currency: "USD" }, instructors, rooms, sessions, customers, bookings, ...(waitlist.length ? { waitlist } : {}) };

  for (const session of sessions) {
    const problems = feasibilityErrors(state, session).filter((problem) => /double booking|daily limit/.test(problem));
    if (problems.length) {
      const other = problems.map((problem) => sessions.find((item) => problem.endsWith(item.id))).find(Boolean);
      const name = (id: string) => instructors.find((item) => item.id === id)?.name ?? rooms.find((item) => item.id === id)?.name;
      const draft = drafts[sessions.indexOf(session)];
      if (errors.length < 20) errors.push(`Row ${draft.line}: ${session.title} overlaps ${other ? `${other.title} (same ${problems[0].startsWith("Room") ? `room, ${name(session.roomId)}` : `instructor, ${name(session.instructorId)}`})` : "another class"}.`);
    }
  }
  const parsed = StateSchema.safeParse(state);
  if (!parsed.success) errors.push("Some values could not be read. Check the dates, times and prices.");
  if (assumedDuration) warnings.push("No end time or duration: classes are assumed to last 60 minutes.");
  if (assumedRoom) warnings.push("No room column: every class is in one room, \"Main studio\".");
  if (assumedCapacity) warnings.push("No capacity: classes hold 12, or everyone booked if that is more.");
  if (assumedPrice) warnings.push(packs || memberships ? "No cash price: classes default to $20.00; pack and membership bookings have no charge." : "No price: each booking is valued at $20.00.");
  if (customers.length) warnings.push("Customer availability isn't in the export: Rebook assumes they can take any time and lets each choose on their own page.");
  warnings.push("Payments are simulated for imported bookings; no PayPal money moves. Customer emails are never contacted.");
  Object.assign(summary, { classes: sessions.length, instructors: instructors.length, rooms: rooms.length, customers: customers.length, bookings: bookings.length });
  return { state: errors.length ? undefined : state, summary, errors, warnings, dateOrder };
}
