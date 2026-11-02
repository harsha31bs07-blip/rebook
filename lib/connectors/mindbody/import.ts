import { z } from "zod";
import { StateSchema } from "../../domain/schemas";
import type { Booking, ClassType, Customer, State } from "../../domain/types";
import { addLocalDays, localParts, zonedTimeToUtc } from "../../domain/time";
import { ruleClassType } from "../../import/fields";
import { createImportStateWorkspace } from "../../import/service";
import { getRepository, StoreError, type Repository } from "../../store";
import { MindbodyClient, mindbodyClient } from "./client";
import type { ClassSnapshot, MbClass, MbPerson, MbService, MbVisit, MbWaitlist, MindbodyLink } from "./types";

export const MindbodyImportSchema = z.strictObject({ weekStart: z.iso.date().refine((date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 1, "Choose a Monday.").optional() });
export function mindbodyClassType(name: string): ClassType | undefined {
  if (/swim|assessment|semi.?private|\bkids\b|children/i.test(name)) return undefined;
  return ruleClassType(name) ?? (/body jam/i.test(name) ? "dance" : /body pump|bottoms up|sweat|trx|daily work ?out/i.test(name) ? "hiit" : undefined);
}
export function localInstant(value: string, timezone: string): string {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? new Date(value).toISOString() : zonedTimeToUtc(value.slice(0, 10), value.slice(11, 16), timezone);
}
export function clientReference(person: MbPerson): { name: string; email: string } {
  return { name: [person.FirstName, person.LastName].filter(Boolean).join(" ") || person.DisplayName || `Client ${person.Id}`,
    email: z.email().safeParse(person.Email).success ? person.Email! : `mb-client-${person.Id}@sync.invalid` };
}
export function visitEntitlement(visit: MbVisit, services: MbService[]): Booking["entitlement"] {
  const service = services.find((row) => row.Id === (visit.ServiceId ?? visit.Service?.Id));
  const name = (service?.Name ?? visit.ServiceName ?? visit.Service?.Name ?? "").trim().slice(0, 60);
  if (/unlimited|membership/i.test(name)) return { kind: "membership", name };
  if (service && typeof service.Count === "number" && Number.isFinite(service.Count) && service.Count >= 0 && Number.isSafeInteger(service.Remaining) && service.Remaining >= 0) {
    const expires = service.ExpirationDate?.slice(0, 10);
    return { kind: "pack", name: name || "Class pack", visitsLeft: service.Remaining, ...(expires && z.iso.date().safeParse(expires).success ? { expires } : {}) };
  }
}
export async function classVisits(client: MindbodyClient, id: number): Promise<MbVisit[]> {
  const result = await client.request<{ Class: { Visits: MbVisit[] } }>(`class/classvisits?ClassID=${id}`);
  if (!Array.isArray(result.Class?.Visits)) throw new StoreError(502, "Mindbody response is missing class visits.");
  return result.Class.Visits.filter((visit) => !visit.LateCancelled);
}
export async function waitlistEntries(client: MindbodyClient, ids: number[]): Promise<MbWaitlist[]> {
  const rows: MbWaitlist[] = [];
  for (let index = 0; index < ids.length; index += 40) rows.push(...await client.list<MbWaitlist>("class/waitlistentries", "WaitlistEntries", { ClassIds: ids.slice(index, index + 40).join(",") }));
  return rows;
}
export async function readClients(client: MindbodyClient, ids: string[]): Promise<MbPerson[]> {
  const rows: MbPerson[] = [];
  for (let index = 0; index < ids.length; index += 40) rows.push(...await client.list<MbPerson>("client/clients", "Clients", { ClientIds: ids.slice(index, index + 40).join(",") }));
  return rows;
}
/**
 * Mindbody allows overlapping classes for one instructor or resource; Rebook's schedule must start feasible.
 * Keep the earlier class of a clash, and spread classes without a resource over numbered spaces so they never collide.
 */
function withoutClashes(rows: MbClass[]) {
  const kept: MbClass[] = [], clashes: MbClass[] = [], spaces = new Map<number, number>();
  const overlaps = (a: MbClass, b: MbClass) => a.StartDateTime < b.EndDateTime && b.StartDateTime < a.EndDateTime;
  for (const row of [...rows].sort((a, b) => a.StartDateTime.localeCompare(b.StartDateTime) || a.Id - b.Id)) {
    const clash = kept.some((other) => overlaps(row, other) && (String(other.Staff.Id) === String(row.Staff.Id) ||
      (!!row.Resource && other.Resource?.Id === row.Resource.Id)));
    if (clash) { clashes.push(row); continue; }
    if (!row.Resource) {
      let space = 1;
      while (kept.some((other) => !other.Resource && other.Location.Id === row.Location.Id && spaces.get(other.Id) === space && overlaps(row, other))) space++;
      spaces.set(row.Id, space);
    }
    kept.push(row);
  }
  return { classes: kept, clashes, spaces };
}
export async function mindbodyWeek(client: MindbodyClient, input: { weekStart?: string; locationId?: number } = {}, now = new Date()) {
  MindbodyImportSchema.parse({ weekStart: input.weekStart });
  const sites = await client.list<{ Id: number; Name: string; TimeZone: string; CurrencyIsoCode: string }>("site/sites", "Sites");
  const site = sites.find((row) => row.Id === client.siteId) ?? sites[0];
  if (!site || site.CurrencyIsoCode !== "USD") throw new StoreError(422, "Mindbody import currently requires a USD studio.");
  const timezone = site.TimeZone, today = localParts(now.toISOString(), timezone);
  const week = input.weekStart ?? addLocalDays(today.dateKey, (8 - today.weekday) % 7), end = addLocalDays(week, 6);
  const all = await client.list<MbClass>("class/classes", "Classes", { StartDateTime: `${week}T00:00:00`, EndDateTime: `${end}T23:59:59` });
  const counts = new Map<number, number>();
  for (const row of all.filter((row) => !row.IsCanceled)) counts.set(row.Location.Id, (counts.get(row.Location.Id) ?? 0) + 1);
  const locationId = input.locationId ?? [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  const selected = all.filter((row) => row.Location.Id === locationId && !row.IsCanceled);
  const omitted = [...new Set(selected.filter((row) => !mindbodyClassType(row.ClassDescription.Name)).map((row) => row.ClassDescription.Name))];
  const { classes, clashes, spaces } = withoutClashes(selected.filter((row) => mindbodyClassType(row.ClassDescription.Name)));
  if (!classes.length) throw new StoreError(422, "No supported Mindbody classes in this location and week.");
  const location = classes[0].Location.Name, warnings: string[] = [];
  if (omitted.length) warnings.push(`Classes left out because they do not map to Rebook's class types: ${omitted.join(", ")}.`);
  if (clashes.length) warnings.push(`Classes left out because Mindbody double-books their instructor or room: ${clashes.map((row) => `${row.ClassDescription.Name} (${row.StartDateTime.slice(0, 16).replace("T", " ")})`).join(", ")}.`);
  const inactive = [...new Set(classes.filter((row) => row.ClassDescription.Active === false).map((row) => row.ClassDescription.Name.trim()))];
  if (inactive.length) warnings.push(`Mindbody no longer schedules new ${inactive.join(", ")} classes: if a recovery moves one to a new time or room, move it in Mindbody by hand. Instructor swaps and bookings still sync.`);
  const visits = new Map<number, MbVisit[]>();
  for (const row of classes) visits.set(row.Id, row.TotalBooked > 0 ? await classVisits(client, row.Id) : []);
  let waitlist: MbWaitlist[] = [];
  try { waitlist = await waitlistEntries(client, classes.map((row) => row.Id)); }
  catch (error) {
    // Some sandbox keys cannot read waitlists. Do not pretend that an error is an empty snapshot.
    if (!(error instanceof StoreError) || /budget/.test(error.message)) throw error;
    warnings.push(`Waitlists were not imported: ${error.message}`);
  }
  const clientIds = [...new Set([...visits.values()].flat().map((row) => String(row.ClientId)).concat(waitlist.map((row) => String(row.ClientId))))];
  const people = await readClients(client, clientIds), services = new Map<string, MbService[]>();
  for (const id of clientIds) services.set(id, await client.list<MbService>("client/clientservices", "ClientServices", { ClientId: id }));
  const link: MindbodyLink = { siteId: client.siteId, locationId: locationId!, location, week, sessions: {}, clients: {}, services: {},
    snapshot: { classes: {}, packs: {} }, ownChangeIds: [], ownWrites: {}, ownPacks: {}, progress: {} };
  const sessions: State["sessions"] = classes.map((row) => {
    const id = `mb-class-${row.Id}`;
    link.sessions[id] = { classId: row.Id, descriptionId: row.ClassDescription.Id, locationId: row.Location.Id, resourceId: row.Resource?.Id, staffId: Number(row.Staff.Id), ...(row.ClassDescription.Active === false ? { inactive: true as const } : {}) };
    const snapshot: ClassSnapshot = { visits: {}, waitlist: {}, capacity: row.MaxCapacity };
    for (const visit of visits.get(row.Id)!) snapshot.visits[visit.Id] = String(visit.ClientId);
    for (const entry of waitlist.filter((entry) => entry.ClassId === row.Id)) snapshot.waitlist[entry.Id] = String(entry.ClientId);
    link.snapshot.classes[row.Id] = snapshot;
    return { id, title: row.ClassDescription.Name, classType: mindbodyClassType(row.ClassDescription.Name)!, instructorId: `mb-staff-${row.Staff.Id}`,
      roomId: row.Resource ? `mb-room-${row.Resource.Id}` : `mb-room-loc-${row.Location.Id}-${spaces.get(row.Id)}`, start: localInstant(row.StartDateTime, timezone), end: localInstant(row.EndDateTime, timezone), capacity: row.MaxCapacity, price: "20.00" };
  });
  const instructors: State["instructors"] = [...new Set(sessions.map((row) => row.instructorId))].map((id) => {
    const mine = sessions.filter((row) => row.instructorId === id), staff = classes.find((row) => `mb-staff-${row.Staff.Id}` === id)!.Staff;
    const perDay = new Map<string, number>();
    for (const row of mine) { const day = localParts(row.start, timezone).dateKey; perDay.set(day, (perDay.get(day) ?? 0) + 1); }
    return { id, name: staff.DisplayName || [staff.FirstName, staff.LastName].filter(Boolean).join(" ") || `Staff ${staff.Id}`,
      skills: [...new Set(mine.map((row) => row.classType))], maxSessionsPerDay: Math.max(3, ...perDay.values()) };
  });
  const rooms: State["rooms"] = [...new Set(sessions.map((row) => row.roomId))].map((id) => {
    const mine = sessions.filter((row) => row.roomId === id), row = classes[sessions.indexOf(mine[0])];
    return { id, name: row.Resource?.Name ?? `${row.Location.Name} space ${spaces.get(row.Id)}`, capacity: Math.max(...mine.map((row) => row.capacity)), supports: [...new Set(mine.map((row) => row.classType))] };
  });
  const customers: Customer[] = clientIds.map((id) => {
    const customerId = `mb-client-${id}`; link.clients[customerId] = id;
    return { id: customerId, ...clientReference(people.find((row) => String(row.Id) === id) ?? { Id: id }), prefs: { acceptsSubstitute: true, availabilityKnown: false,
      windows: Array.from({ length: 7 }, (_, weekday) => ({ weekday, from: "00:00", to: "23:59" })) } };
  });
  const bookings: Booking[] = [];
  for (const row of classes) for (const visit of visits.get(row.Id)!) {
    const clientId = String(visit.ClientId), id = `mb-visit-${visit.Id}`, entitlement = visitEntitlement(visit, services.get(clientId) ?? []);
    if (visit.ServiceId ?? visit.Service?.Id) link.services[id] = (visit.ServiceId ?? visit.Service!.Id)!;
    if (entitlement?.kind === "pack") {
      const previous = link.snapshot.packs[clientId], serviceId = link.services[id];
      if (previous && previous.serviceId !== serviceId) warnings.push(`Client ${clientId} has multiple class packs; Rebook's balance view tracks the last imported pack.`);
      link.snapshot.packs[clientId] = { serviceId, remaining: entitlement.visitsLeft!, expires: entitlement.expires };
    }
    bookings.push({ id, sessionId: `mb-class-${row.Id}`, customerId: `mb-client-${clientId}`, status: "confirmed", amount: entitlement ? "0.00" : "20.00", bookedAt: now.toISOString(),
      ...(entitlement ? { entitlement } : { payment: { orderId: `IMPORT-ORDER-${id}`, captureId: `IMPORT-CAP-${id}`, simulated: true } }) });
  }
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const openHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => {
    const mine = sessions.filter((row) => localParts(row.start, timezone).weekday === day);
    return [day, mine.length ? [{ open: clock(Math.min(...mine.map((row) => localParts(row.start, timezone).minutesOfDay))), close: clock(Math.max(...mine.map((row) => localParts(row.end, timezone).minutesOfDay))) }] : []];
  }));
  const state = StateSchema.parse({ studio: { id: "studio", name: `${site.Name} · ${location}`, timezone, currency: "USD", weekStart: zonedTimeToUtc(week, "00:00", timezone), openHours },
    sessions, instructors, rooms, customers, bookings, waitlist: waitlist.map((entry) => ({ id: `mb-waitlist-${entry.Id}`, sessionId: `mb-class-${entry.ClassId}`, customerId: `mb-client-${entry.ClientId}`, joinedAt: now.toISOString() })) });
  warnings.push("No per-class price: classes default to $20.00; pack and membership bookings have no charge.",
    "Opening hours are assumed from this week's classes. Instructors teach the class types they teach this week and are free whenever they are not teaching.",
    "Customer availability is unknown: customers are assumed to fit any time. Payments are simulated; customer emails are never contacted.");
  return { state, link, summary: { classes: sessions.length, instructors: instructors.length, rooms: rooms.length, customers: customers.length, bookings: bookings.length, weekOf: week, shiftedWeeks: 0 }, warnings };
}
export async function createMindbodyWorkspace(input: { weekStart?: string }, repository: Repository = getRepository(), client = mindbodyClient()) {
  client.beginOperation(); const result = await mindbodyWeek(client, input);
  return repository.transaction(() => {
    const workspace = createImportStateWorkspace(result.state, repository);
    repository.saveMindbodyLink(workspace.id, result.link);
    return { id: workspace.id, path: `/w/${workspace.id}`, summary: result.summary, warnings: result.warnings };
  });
}
