import { addLocalDays, localParts } from "../../domain/time";
import { getRepository, StoreError, withWorkspaceLock, type Repository } from "../../store";
import type { InboundEvent } from "../../sync/schemas";
import { receiveEvents } from "../../sync/service";
import { MindbodyClient, mindbodyClient } from "./client";
import { classVisits, clientReference, readClients, visitEntitlement, waitlistEntries } from "./import";
import { withMindbodyLock } from "./link";
import type { MbClass, MbService, MbVisit } from "./types";

export async function pullFromMindbody(workspaceId: string, repository: Repository = getRepository(), client: MindbodyClient = mindbodyClient()) {
  client.beginOperation();
  return withMindbodyLock(workspaceId, repository, async (fence) => {
    const link = repository.mindbodyLink(workspaceId)!, state = repository.requireReadyWorkspace(workspaceId).state;
    if (link.siteId !== client.siteId) throw new StoreError(422, "Mindbody site does not match this workspace.");
    const dates = [link.week, addLocalDays(link.week, 6), ...state.sessions.map((row) => localParts(row.start, state.studio.timezone).dateKey)].sort();
    const rows = await client.list<MbClass>("class/classes", "Classes", { StartDateTime: `${dates[0]}T00:00:00`, EndDateTime: `${dates.at(-1)}T23:59:59` });
    const ids = Object.values(link.sessions).map((row) => row.classId);
    const waitlist = await waitlistEntries(client, ids), visits = new Map<number, MbVisit[]>();
    for (const id of ids) {
      const row = rows.find((row) => row.Id === id);
      if (!row) throw new StoreError(502, `Mindbody class ${id} was not returned. Snapshot retained; the sandbox may have reset.`);
      visits.set(id, row.IsCanceled ? [] : row.TotalBooked > 0 || Object.keys(link.snapshot.classes[id]?.visits ?? {}).length ? await classVisits(client, id) : []);
    }
    const clientIds = [...new Set([...visits.values()].flat().map((row) => String(row.ClientId)).concat(waitlist.map((row) => String(row.ClientId)), Object.keys(link.snapshot.packs)))];
    const unknown = clientIds.filter((id) => !Object.entries(link.clients).some(([customerId, value]) => value === id && state.customers.some((row) => row.id === customerId)));
    const people = await readClients(client, unknown), services = new Map<string, MbService[]>();
    for (const id of clientIds.filter((id) => unknown.includes(id) || link.snapshot.packs[id] || [...visits.values()].flat().some((visit) => String(visit.ClientId) === id && !Object.values(link.snapshot.classes).some((snapshot) => String(visit.Id) in snapshot.visits)))) {
      services.set(id, await client.list<MbService>("client/clientservices", "ClientServices", { ClientId: id }));
    }
    const person = (id: string) => {
      const knownId = Object.entries(link.clients).find(([, value]) => value === id)?.[0], known = state.customers.find((row) => row.id === knownId);
      return known ? { name: known.name, email: known.email } : clientReference(people.find((row) => String(row.Id) === id) ?? { Id: id });
    };
    const queue: { event: InboundEvent; accept(): void }[] = [];
    const bases = new Map<string, string>();
    const eventId = (base: string) => {
      // A value may recur after a later change. Keep retries stable without mistaking that transition for the old event.
      const previous = link.eventVersions?.[base] ?? 0, id = previous ? `${base}:${previous + 1}` : base;
      bases.set(id, base); return id;
    };
    for (const [sessionId, mapping] of Object.entries(link.sessions)) {
      const classId = mapping.classId, remote = rows.find((row) => row.Id === classId)!;
      const snapshot = link.snapshot.classes[classId] ??= { visits: {}, waitlist: {}, capacity: remote.MaxCapacity };
      const session = { id: sessionId }, currentVisits = visits.get(classId)!;
      const current = Object.fromEntries(currentVisits.map((row) => [row.Id, String(row.ClientId)]));
      const currentWaitlist = Object.fromEntries(waitlist.filter((row) => row.ClassId === classId).map((row) => [row.Id, String(row.ClientId)]));
      const ownAdded = new Set(Object.entries(link.ownWrites).filter(([key, action]) => key.startsWith(`${classId}:`) && action === "added").map(([key]) => key.slice(String(classId).length + 1)));
      for (const clientId of new Set([...Object.values(snapshot.visits), ...Object.values(current)])) {
        const marker = `${classId}:${clientId}`, own = link.ownWrites[marker];
        if ((own === "added" && Object.values(current).includes(clientId)) || (own === "removed" && !Object.values(current).includes(clientId))) {
          for (const [id, value] of Object.entries(snapshot.visits)) if (value === clientId) delete snapshot.visits[id];
          for (const [id, value] of Object.entries(current)) if (value === clientId) snapshot.visits[id] = value;
          delete link.ownWrites[marker];
        }
      }
      for (const [id, clientId] of Object.entries(snapshot.visits)) if (!(id in current)) {
        queue.push({ event: { eventId: eventId(`mb:booking.cancelled:${classId}:${clientId}:${id}`), type: "booking.cancelled", session, customer: person(clientId) }, accept: () => { delete snapshot.visits[id]; } });
      }
      for (const [id, clientId] of Object.entries(snapshot.waitlist)) if (!(id in currentWaitlist)) {
        if (ownAdded.has(clientId)) { delete snapshot.waitlist[id]; continue; }
        queue.push({ event: { eventId: eventId(`mb:waitlist.left:${classId}:${clientId}:${id}`), type: "waitlist.left", session, customer: person(clientId) }, accept: () => { delete snapshot.waitlist[id]; } });
      }
      if (!remote.IsCanceled && remote.MaxCapacity !== snapshot.capacity) queue.push({ event: { eventId: eventId(`mb:capacity:${classId}:${remote.MaxCapacity}`), type: "session.capacity", session, capacity: remote.MaxCapacity }, accept: () => { snapshot.capacity = remote.MaxCapacity; } });
      for (const [id, clientId] of Object.entries(current)) if (!(id in snapshot.visits)) {
        const visit = currentVisits.find((row) => String(row.Id) === id)!, entitlement = visitEntitlement(visit, services.get(clientId) ?? []);
        queue.push({ event: { eventId: eventId(`mb:booking.created:${classId}:${clientId}:${id}`), type: "booking.created", session, customer: person(clientId), ...(entitlement ? { entitlement } : {}) }, accept: () => {
          snapshot.visits[id] = clientId;
          const latest = repository.requireReadyWorkspace(workspaceId).state, reference = person(clientId);
          const customer = latest.customers.find((row) => row.email.toLowerCase() === reference.email.toLowerCase());
          const booking = latest.bookings.find((row) => row.customerId === customer?.id && row.sessionId === sessionId && ["confirmed", "moved"].includes(row.status));
          if (customer) link.clients[customer.id] = clientId;
          if (booking && (visit.ServiceId ?? visit.Service?.Id)) link.services[booking.id] = (visit.ServiceId ?? visit.Service!.Id)!;
          if (entitlement?.kind === "pack") link.snapshot.packs[clientId] = { serviceId: (visit.ServiceId ?? visit.Service!.Id)!, remaining: entitlement.visitsLeft!, expires: entitlement.expires };
        } });
      }
      for (const [id, clientId] of Object.entries(currentWaitlist)) if (!(id in snapshot.waitlist)) {
        queue.push({ event: { eventId: eventId(`mb:waitlist.joined:${classId}:${clientId}:${id}`), type: "waitlist.joined", session, customer: person(clientId) }, accept: () => { snapshot.waitlist[id] = clientId; } });
      }
    }
    for (const [clientId, snapshot] of Object.entries(link.snapshot.packs)) {
      const service = services.get(clientId)?.find((row) => row.Id === snapshot.serviceId);
      if (!service) continue;
      if (link.ownPacks[clientId] === service.Remaining) { snapshot.remaining = service.Remaining; delete link.ownPacks[clientId]; }
      const expires = service.ExpirationDate?.slice(0, 10);
      if (service.Remaining !== snapshot.remaining || expires !== snapshot.expires) queue.push({ event: { eventId: eventId(`mb:pack:${clientId}:${service.Remaining}`), type: "pack.balance", customer: person(clientId), visitsLeft: service.Remaining, ...(expires ? { expires } : {}) }, accept: () => { snapshot.remaining = service.Remaining; snapshot.expires = expires; } });
    }
    const results: Awaited<ReturnType<typeof receiveEvents>>["results"] = [];
    for (let index = 0; index < queue.length; index += 100) {
      fence();
      const batch = queue.slice(index, index + 100), received = await receiveEvents(workspaceId, { events: batch.map((row) => row.event) }, repository);
      for (const result of received.results) {
        if (result.status !== "rejected") {
          batch.find((row) => row.event.eventId === result.eventId)!.accept();
          const base = bases.get(result.eventId)!; link.eventVersions ??= {}; link.eventVersions[base] = (link.eventVersions[base] ?? 0) + 1;
        }
        results.push(result);
      }
      fence(); repository.saveMindbodyLink(workspaceId, link);
    }
    await withWorkspaceLock(repository, workspaceId, () => repository.transaction(() => {
      const latest = repository.requireReadyWorkspace(workspaceId).state;
      for (const clientId of unknown) {
        const reference = person(clientId), customer = latest.customers.find((row) => row.email.toLowerCase() === reference.email.toLowerCase());
        if (customer) link.clients[customer.id] = clientId;
      }
      for (const booking of latest.bookings.filter((row) => !row.entitlement && !row.payment && (row.customerId in link.clients))) {
        const captureId = `IMPORT-CAP-${booking.id}`;
        booking.payment = { orderId: `IMPORT-ORDER-${booking.id}`, captureId, simulated: true };
        repository.appendLedger({ workspaceId, bookingId: booking.id, kind: "capture", amount: booking.amount, paypalId: captureId, captureId, requestId: `${workspaceId}${booking.id}`, status: "SIMULATED" });
      }
      repository.saveState(workspaceId, latest);
      link.lastPull = new Date().toISOString(); fence(); repository.saveMindbodyLink(workspaceId, link);
    }));
    const applied = queue.filter((row) => results.some((result) => result.eventId === row.event.eventId && result.status === "applied"));
    return { results, summary: { bookings: applied.filter((row) => row.event.type === "booking.created").length, cancellations: applied.filter((row) => row.event.type === "booking.cancelled").length,
      other: applied.filter((row) => !row.event.type.startsWith("booking.")).length } };
  });
}
