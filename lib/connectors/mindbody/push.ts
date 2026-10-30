import { localParts } from "../../domain/time";
import type { Session, State } from "../../domain/types";
import { getRepository, StoreError, withWorkspaceLock, type Repository } from "../../store";
import { pendingChanges, type SyncChange } from "../../sync/feed";
import { acknowledge } from "../../sync/service";
import { MindbodyClient, MindbodyError, mindbodyClient } from "./client";
import { withMindbodyLock } from "./link";
import { mindbodyClassType } from "./import";
import { addBooking, addClient, cancelClass, oneOff, removeBooking, substitute } from "./requests";
import type { MbClass, MbPerson, MbService, MindbodyLink } from "./types";

type Context = { client: MindbodyClient; link: MindbodyLink; state: State; changeId?: string; save(): void };
function mapping(link: MindbodyLink, id: string) {
  const row = link.sessions[id];
  if (!row) throw new StoreError(422, "This class has no Mindbody mapping.");
  return row;
}
async function write(context: Context, path: string, body: unknown, already: RegExp) {
  try { return await context.client.request(path, body); }
  catch (error) { if (!(error instanceof MindbodyError) || !already.test(error.message)) throw error; }
}
function packEffect(context: Context, clientId: string, delta: number, key: string) {
  const pack = context.link.snapshot.packs[clientId], effectId = `effect:${context.changeId}:${key}:${clientId}`;
  if (!pack || context.link.progress[effectId]?.done) return;
  context.link.ownPacks[clientId] = Math.max(0, (context.link.ownPacks[clientId] ?? pack.remaining) + delta);
  context.link.progress[effectId] = { done: true };
}
function cancelledClassPacks(context: Context, classId: number) {
  for (const [visitId, clientId] of Object.entries(context.link.snapshot.classes[classId]?.visits ?? {})) {
    if (context.link.services[`mb-visit-${visitId}`] === context.link.snapshot.packs[clientId]?.serviceId) packEffect(context, clientId, 1, `${classId}:${visitId}:removed`);
  }
}
async function changeBooking(context: Context, action: "added" | "removed", clientId: string, classId: number, serviceId?: number) {
  // Persist intent before the request: an uncertain response must not echo into Rebook on pull.
  const marker = `${classId}:${clientId}`, previous = context.link.ownWrites[marker];
  context.link.ownWrites[marker] = action; context.save();
  try {
    if (action === "added") await write(context, "class/addclienttoclass", addBooking(clientId, classId, serviceId), /already (?:in|booked|enrolled)|already.*class/i);
    else await write(context, "class/removeclientfromclass", removeBooking(clientId, classId), /no class visit found|not (?:in|booked|enrolled)|already (?:removed|cancelled|canceled)/i);
  } catch (error) {
    if (error instanceof MindbodyError && error.upstreamStatus >= 400 && error.upstreamStatus < 500 && error.upstreamStatus !== 429) {
      if (previous) context.link.ownWrites[marker] = previous; else delete context.link.ownWrites[marker]; context.save();
    }
    throw error;
  }
  const pack = context.link.snapshot.packs[clientId];
  const usedPack = action === "added" ? serviceId === pack?.serviceId : Object.entries(context.link.snapshot.classes[classId]?.visits ?? {}).some(([visitId, id]) => id === clientId && context.link.services[`mb-visit-${visitId}`] === pack?.serviceId);
  if (pack && usedPack) packEffect(context, clientId, action === "added" ? -1 : 1, `${classId}:${action}`);
  context.save();
}
async function findClient(context: Context, customer: { id: string; name: string; email?: string }): Promise<string> {
  const existing = context.link.clients[customer.id] ?? customer.id.match(/^mb-client-(.+)$/)?.[1];
  if (existing) return existing;
  if (!customer.email || customer.email.endsWith("@sync.invalid")) throw new StoreError(422, "An email is required to create a Mindbody client.");
  const matches = (await context.client.list<MbPerson>("client/clients", "Clients", { SearchText: customer.email })).filter((row) => row.Email?.toLowerCase() === customer.email!.toLowerCase());
  if (matches.length > 1) throw new StoreError(409, "More than one Mindbody client has this email.");
  const result = matches[0] ?? (await context.client.request<{ Client: MbPerson }>("client/addclient", addClient(customer.name, customer.email), true, false)).Client;
  if (!result?.Id) throw new StoreError(502, "Mindbody did not return the created client.");
  context.link.clients[customer.id] = String(result.Id); context.save(); return String(result.Id);
}
async function moveSession(context: Context, change: Extract<SyncChange, { type: "session.moved" }>) {
  const { link, state, client } = context, original = mapping(link, change.session.id), progress = link.progress[change.id] ??= {};
  const instructors = state.instructors.filter((row) => row.name === change.after.instructor), rooms = state.rooms.filter((row) => row.name === change.after.room);
  if (instructors.length !== 1 || rooms.length !== 1) throw new StoreError(422, "The replacement instructor or room is missing or ambiguous in Mindbody.");
  const instructor = instructors[0], room = rooms[0];
  const staffId = Number(instructor?.id.match(/^mb-staff-(\d+)$/)?.[1]);
  if (!staffId || !room) throw new StoreError(422, "The replacement instructor or room has no Mindbody mapping.");
  const next = { ...original, staffId, resourceId: room.id.startsWith("mb-room-loc-") ? undefined : Number(room.id.match(/^mb-room-(\d+)$/)?.[1]) };
  if (next.resourceId !== undefined && !Number.isSafeInteger(next.resourceId)) throw new StoreError(422, "The replacement room has no Mindbody resource.");
  if (change.before.start === change.after.start && change.before.end === change.after.end && change.before.room === change.after.room) {
    await write(context, "class/substituteclassteacher", substitute(original.classId, staffId), /already.*(?:teacher|instructor)/i);
    original.staffId = staffId; return;
  }
  if (original.inactive) throw new MindbodyError(422, `Mindbody no longer schedules new "${change.session.title}" classes (its class description is inactive). Move this class in Mindbody by hand.`);
  const session = state.sessions.find((row) => row.id === change.session.id) ?? { id: change.session.id, title: change.session.title,
    classType: mindbodyClassType(change.session.title) ?? "hiit", start: change.before.start, end: change.before.end, instructorId: instructor.id, roomId: room.id,
    capacity: link.snapshot.classes[original.classId]?.capacity ?? 12, price: "20.00" };
  const desired: Session = { ...session, start: change.after.start, end: change.after.end, instructorId: instructor!.id, roomId: room.id };
  const date = localParts(desired.start, state.studio.timezone).dateKey;
  const candidates = () => client.list<MbClass>("class/classes", "Classes", { StartDateTime: `${date}T00:00:00`, EndDateTime: `${date}T23:59:59` });
  const matches = (rows: MbClass[]) => rows.filter((row) => row.Id !== original.classId && !progress.existingIds?.includes(row.Id) && !row.IsCanceled && row.ClassDescription.Id === next.descriptionId && Number(row.Staff.Id) === staffId
    && row.Location.Id === next.locationId && (row.Resource?.Id ?? undefined) === next.resourceId && row.StartDateTime.slice(11, 16) === oneOff(desired, next, state.studio.timezone).StartTime.slice(11, 16));
  if (!progress.newClassId) {
    if (!progress.existingIds) { progress.existingIds = (await candidates()).map((row) => row.Id); context.save(); }
    let found = matches(await candidates());
    if (!found.length && !progress.scheduleRequested) {
      progress.scheduleRequested = true; context.save();
      let created: { ClassInstanceIds?: number[] };
      try { created = await client.request("class/addclassschedule", oneOff(desired, next, state.studio.timezone), true, false); }
      catch (error) {
        // A definite validation error made no schedule; an uncertain server response needs discovery on retry.
        if (error instanceof MindbodyError && error.upstreamStatus >= 400 && error.upstreamStatus < 500) {
          progress.scheduleRequested = false; context.save();
          if (/description id not active/i.test(error.message)) throw new MindbodyError(error.upstreamStatus, `Mindbody no longer schedules new "${session.title}" classes (its class description is inactive). Move this class in Mindbody by hand.`);
        }
        throw error;
      }
      const instance = created.ClassInstanceIds?.length === 1 ? created.ClassInstanceIds[0] : undefined;
      found = instance ? [{ Id: instance } as MbClass] : matches(await candidates());
    }
    if (found.length !== 1) throw new StoreError(502, found.length ? "More than one replacement Mindbody class was found; review the sandbox schedule." : "Replacement Mindbody class not found yet. Retry to discover it before creating another schedule.");
    progress.newClassId = found[0].Id; context.save();
  }
  for (const booking of state.bookings.filter((row) => row.sessionId === session.id && ["confirmed", "moved"].includes(row.status))) {
    const customer = state.customers.find((row) => row.id === booking.customerId)!;
    const clientId = await findClient(context, customer);
    await changeBooking(context, "added", clientId, progress.newClassId, link.services[booking.id]);
  }
  for (const clientId of Object.values(link.snapshot.classes[original.classId]?.visits ?? {})) link.ownWrites[`${original.classId}:${clientId}`] = "removed";
  context.save();
  await write(context, "class/cancelsingleclass", cancelClass(original.classId), /already cancel[le]*d/i);
  cancelledClassPacks(context, original.classId);
  link.sessions[session.id] = { ...next, classId: progress.newClassId };
  link.snapshot.classes[progress.newClassId] ??= { visits: {}, waitlist: {}, capacity: desired.capacity };
  // The old roster belongs to a cancelled instance and is no longer polled.
}
export async function applyMindbodyChange(context: Context, change: SyncChange): Promise<void> {
  context = { ...context, changeId: change.id };
  const { link } = context;
  if (link.progress[change.id]?.done) return;
  if (change.type === "session.moved") await moveSession(context, change);
  else if (change.type === "session.cancelled") {
    const row = mapping(link, change.session.id);
    for (const clientId of Object.values(link.snapshot.classes[row.classId]?.visits ?? {})) link.ownWrites[`${row.classId}:${clientId}`] = "removed";
    context.save(); await write(context, "class/cancelsingleclass", cancelClass(row.classId), /already cancel[le]*d/i); cancelledClassPacks(context, row.classId);
  } else if (change.type === "booking.moved" && change.from.id === change.to.id) {
    const sessionChange = change.id.replace(/:booking:.*$/, `:session:${change.from.id}`);
    if (change.id.startsWith("plan:") && !link.progress[sessionChange]?.done && !link.ownChangeIds.includes(sessionChange)) throw new StoreError(409, "Send the parent class move first.");
  } else if (change.type === "pack.visit_returned") {
    const clientId = await findClient(context, change.customer), pack = link.snapshot.packs[clientId];
    if (pack) {
      const service = (await context.client.list<MbService>("client/clientservices", "ClientServices", { ClientId: clientId })).find((row) => row.Id === pack.serviceId);
      if (service && service.Remaining === (link.ownPacks[clientId] ?? change.visitsLeftAfter)) link.ownPacks[clientId] = service.Remaining;
    }
  } else {
    const clientId = await findClient(context, change.customer);
    if (change.type === "booking.moved") {
      await changeBooking(context, "removed", clientId, mapping(link, change.from.id).classId);
      await changeBooking(context, "added", clientId, mapping(link, change.to.id).classId, link.services[change.bookingId]);
    } else if (change.type === "booking.cancelled") await changeBooking(context, "removed", clientId, mapping(link, change.session.id).classId);
    else if (change.type === "booking.created") await changeBooking(context, "added", clientId, mapping(link, change.session.id).classId, link.services[change.bookingId]);
  }
  (link.progress[change.id] ??= {}).done = true;
  if (!link.ownChangeIds.includes(change.id)) link.ownChangeIds.push(change.id);
  context.save();
}
export async function pushToMindbody(workspaceId: string, repository: Repository = getRepository(), client = mindbodyClient()) {
  client.beginOperation();
  return withMindbodyLock(workspaceId, repository, async (fence) => {
    const applied: string[] = [], failed: { id: string; message: string }[] = [];
    await withWorkspaceLock(repository, workspaceId, async (owner) => {
      const link = repository.mindbodyLink(workspaceId)!;
      if (link.siteId !== client.siteId) throw new StoreError(422, "Mindbody site does not match this workspace.");
      const save = () => { fence(); repository.renewLock(workspaceId, owner); repository.saveMindbodyLink(workspaceId, link); };
      const state = repository.requireReadyWorkspace(workspaceId).state;
      const rank = (row: SyncChange) => row.type.startsWith("session.") ? 0 : row.type === "pack.visit_returned" ? 2 : 1;
      const changes = pendingChanges(workspaceId, repository).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || rank(a) - rank(b));
      for (const change of changes) {
        try {
          fence();
          if (change.type === "pack.visit_returned" && changes.some((row) => row.type === "booking.cancelled" && row.bookingId === change.bookingId && !link.progress[row.id]?.done)) throw new StoreError(409, "Send the on-time booking cancellation before confirming its returned pack visit.");
          await applyMindbodyChange({ client, link, state, save }, change); applied.push(change.id);
        }
        catch (error) { failed.push({ id: change.id, message: client.safeMessage(error instanceof StoreError ? error.message : "Mindbody change failed. Retry this change.") }); }
      }
      link.lastPush = new Date().toISOString(); save();
    });
    await acknowledge(workspaceId, applied, repository);
    return { applied: applied.length, failed, pending: pendingChanges(workspaceId, repository).length };
  });
}
