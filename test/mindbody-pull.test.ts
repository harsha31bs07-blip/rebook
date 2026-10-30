import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMindbodyWorkspace } from "../lib/connectors/mindbody/import";
import { pullFromMindbody } from "../lib/connectors/mindbody/pull";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import { sandbox, reply } from "./mindbody-fixture";

let directory: string, repository: Repository, api: ReturnType<typeof sandbox>, id: string;
const state = () => repository.requireWorkspace(id).state;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "rebook-mb-pull-")); vi.stubEnv("DATA_DIR", directory); repository = getRepository(); api = sandbox();
  id = (await createMindbodyWorkspace({}, repository, api.client)).id; api.calls.length = 0;
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });
it("pulls a new visit with a deterministic id and never repeats it", async () => {
  api.people.push({ Id: "700", FirstName: "Reese", LastName: "Lane", Email: "reese@example.com" });
  api.visits[19167].push({ Id: 701, ClientId: "700" });
  const result = await pullFromMindbody(id, repository, api.client);
  expect(result.results).toEqual([{ eventId: "mb:booking.created:19167:700:701", status: "applied" }]);
  const customer = state().customers.find((row) => row.email === "reese@example.com")!;
  expect(repository.mindbodyLink(id)!.clients[customer.id]).toBe("700");
  expect(state().bookings.find((row) => row.customerId === customer.id)).toMatchObject({ payment: { simulated: true } });
  expect((await pullFromMindbody(id, repository, api.client)).results).toEqual([]);
});
it.each(["removed", "late-cancelled", "class-cancelled"])("pulls %s visits as booking cancellations", async (kind) => {
  if (kind === "removed") api.visits[19167].shift();
  else if (kind === "late-cancelled") api.visits[19167][0].LateCancelled = true;
  else api.classes[0].IsCanceled = true;
  const result = await pullFromMindbody(id, repository, api.client);
  expect(result.results).toContainEqual({ eventId: "mb:booking.cancelled:19167:100015648:100343877", status: "applied" });
  expect(state().bookings[0].status).toBe("cancelled");
  expect(repository.listSyncEvents(id)[0].type).toBe("booking.cancelled");
});
it("pulls waitlist joins and leaves, capacity and pack Remaining changes", async () => {
  api.people.push({ Id: "800", FirstName: "River", LastName: "Grey", Email: "river@example.com" });
  api.waitlist.push({ Id: 801, ClassId: 19167, ClientId: "800" });
  api.classes[0].MaxCapacity = 20; api.services["100015648"][0].Remaining = 6;
  const first = await pullFromMindbody(id, repository, api.client);
  expect(first.results.every((row) => row.status === "applied")).toBe(true);
  expect(first.results.map((row) => row.eventId)).toEqual(["mb:capacity:19167:20", "mb:waitlist.joined:19167:800:801", "mb:pack:100015648:6"]);
  expect(state().waitlist).toHaveLength(1); expect(state().sessions[0].capacity).toBe(20);
  expect(state().syncPackBalances?.[0].visitsLeft).toBe(6);
  api.waitlist.length = 0;
  expect((await pullFromMindbody(id, repository, api.client)).results).toEqual([{ eventId: "mb:waitlist.left:19167:800:801", status: "applied" }]);
  expect(state().waitlist).toEqual([]);
});
it("retains a rejected event's baseline and retries it next pull", async () => {
  api.classes[0].MaxCapacity = 40;
  const first = await pullFromMindbody(id, repository, api.client);
  expect(first.results[0]).toMatchObject({ eventId: "mb:capacity:19167:40", status: "rejected" });
  expect(repository.mindbodyLink(id)!.snapshot.classes[19167].capacity).toBe(30);
  const latest = state(); latest.rooms[0].capacity = 50; repository.saveState(id, latest);
  expect((await pullFromMindbody(id, repository, api.client)).results).toEqual([{ eventId: "mb:capacity:19167:40", status: "applied" }]);
  expect(repository.mindbodyLink(id)!.snapshot.classes[19167].capacity).toBe(40);
});
it("does not echo own roster writes or confirmed pack returns", async () => {
  const link = repository.mindbodyLink(id)!;
  link.ownWrites["19167:100015648"] = "removed"; link.ownPacks["100015648"] = 8;
  repository.saveMindbodyLink(id, link); api.visits[19167].shift(); api.services["100015648"][0].Remaining = 8;
  expect((await pullFromMindbody(id, repository, api.client)).results).toEqual([]);
  expect(repository.mindbodyLink(id)!.ownWrites).toEqual({}); expect(repository.mindbodyLink(id)!.ownPacks).toEqual({});
});
it("retains the snapshot when a remote read fails or the nightly reset removes a class", async () => {
  const before = repository.mindbodyLink(id)!.snapshot;
  api.hook = (call) => call.path === "class/waitlistentries" ? reply({ Error: { Message: "Permission denied" } }, 403) : undefined;
  await expect(pullFromMindbody(id, repository, api.client)).rejects.toThrow("Permission denied");
  expect(repository.mindbodyLink(id)!.snapshot).toEqual(before);
  api.hook = undefined; api.classes.shift();
  await expect(pullFromMindbody(id, repository, api.client)).rejects.toThrow("sandbox may have reset");
  expect(repository.mindbodyLink(id)!.snapshot).toEqual(before);
});
it("accepts repeated capacity transitions with deterministic transition ids", async () => {
  api.classes[0].MaxCapacity = 20; await pullFromMindbody(id, repository, api.client);
  api.classes[0].MaxCapacity = 25; await pullFromMindbody(id, repository, api.client);
  api.classes[0].MaxCapacity = 20;
  const result = await pullFromMindbody(id, repository, api.client);
  expect(result.results[0].status).toBe("applied"); expect(result.results[0].eventId).toBe("mb:capacity:19167:20:2");
  expect(state().sessions[0].capacity).toBe(20);
});
it("recovers duplicate inbound delivery after a crash before snapshot persistence", async () => {
  const before = repository.mindbodyLink(id)!;
  api.people.push({ Id: "700", FirstName: "Reese", LastName: "Lane", Email: "reese@example.com" });
  api.visits[19167].push({ Id: 701, ClientId: "700" });
  await pullFromMindbody(id, repository, api.client);
  repository.saveMindbodyLink(id, before);
  expect((await pullFromMindbody(id, repository, api.client)).results).toEqual([{ eventId: "mb:booking.created:19167:700:701", status: "duplicate" }]);
  expect(repository.mindbodyLink(id)!.snapshot.classes[19167].visits[701]).toBe("700");
});
