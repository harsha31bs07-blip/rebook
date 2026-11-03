import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMindbodyWorkspace } from "../lib/connectors/mindbody/import";
import { pushToMindbody } from "../lib/connectors/mindbody/push";
import { pullFromMindbody } from "../lib/connectors/mindbody/pull";
import * as feed from "../lib/sync/feed";
import type { SyncChange, SyncSession } from "../lib/sync/feed";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import { sandbox, reply } from "./mindbody-fixture";
import { replan } from "../lib/solver/replan";
import { executePlan } from "../lib/executor/executePlan";
import { askNextCover, respondToCover } from "../lib/recovery/cover-pay";
import { customerChoice, submitChoice } from "../lib/choices/service";
import { oneOff } from "../lib/connectors/mindbody/requests";

let directory: string, repository: Repository, api: ReturnType<typeof sandbox>, id: string, changes: SyncChange[];
const state = () => repository.requireWorkspace(id).state;
const person = () => state().customers[0];
function session(index = 0): SyncSession {
  const data = state(), row = data.sessions[index];
  return { id: row.id, title: row.title, start: row.start, end: row.end, instructor: data.instructors.find((item) => item.id === row.instructorId)!.name, room: data.rooms.find((item) => item.id === row.roomId)!.name };
}
const base = (id = "one") => ({ id, occurredAt: "2026-10-30T12:00:00Z" });
const writes = () => api.calls.filter((row) => row.body && row.path !== "usertoken/issue");
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "rebook-mb-push-")); vi.stubEnv("DATA_DIR", directory); repository = getRepository(); api = sandbox();
  id = (await createMindbodyWorkspace({}, repository, api.client)).id; api.calls.length = 0; changes = [];
  vi.spyOn(feed, "allChanges").mockImplementation(() => changes);
  vi.spyOn(feed, "pendingChanges").mockImplementation(() => changes.filter((row) => !repository.syncAcks(id).has(row.id)));
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });
it("substitutes only the instructor at the same time and room", async () => {
  const before = session(), after = { ...before, instructor: state().instructors.find((row) => row.name !== before.instructor)!.name };
  changes.push({ ...base(), type: "session.moved", session: after, before, after });
  expect(await pushToMindbody(id, repository, api.client)).toMatchObject({ applied: 1, pending: 0, failed: [] });
  expect(writes()).toHaveLength(1); expect(writes()[0]).toMatchObject({ path: "class/substituteclassteacher", body: { ClassId: 19167, StaffId: repository.mindbodyLink(id)!.sessions[before.id].staffId } });
  expect(repository.syncAcks(id).has("one")).toBe(true);
});
it("does not echo its own whole-class cancellation on pull, including an empty roster", async () => {
  const empty = state().sessions[1], data = state(); data.sessions = data.sessions.filter((row) => row.id !== empty.id); repository.saveState(id, data);
  const remote = api.classes.find((row) => row.Id === repository.mindbodyLink(id)!.sessions[empty.id].classId)!;
  const view = { id: empty.id, title: empty.title, start: empty.start, end: empty.end, instructor: "Teacher", room: "Room" };
  changes.push({ ...base(), type: "session.cancelled", session: view });
  expect((await pushToMindbody(id, repository, api.client)).applied).toBe(1); expect(remote.IsCanceled).toBe(true);
  expect((await pullFromMindbody(id, repository, api.client)).results).toEqual([]);
});
async function realCover() {
  vi.restoreAllMocks();
  const data = state(), original = data.sessions[0], teacher = data.instructors.find((row) => row.id === original.instructorId)!;
  data.instructors.push({ ...teacher, id: "mb-staff-1", name: "First substitute" }, { ...teacher, id: "mb-staff-2", name: "Next substitute" });
  repository.saveState(id, data);
  const plan = repository.createPlan(id, replan(data, { kind: "instructor_unavailable", instructorId: teacher.id, from: original.start, to: original.end }));
  await executePlan(id, plan.id, repository);
  expect((await pushToMindbody(id, repository, api.client)).failed).toEqual([]);
  api.calls.length = 0;
  return { plan, original, cover: repository.listCoverLinks(id)[0] };
}
it("sends a replacement cover from the real feed as a new substitute call", async () => {
  const { plan, original, cover } = await realCover(); expect(cover).toBeTruthy();
  await respondToCover(repository.coverToken(cover), "decline", repository);
  await askNextCover(id, plan.id, original.id, repository);
  expect(await pushToMindbody(id, repository, api.client)).toMatchObject({ applied: 1, failed: [], pending: 0 });
  const replacement = state().sessions.find((row) => row.id === original.id)!.instructorId;
  expect(replacement).not.toBe(cover.instructorId);
  expect(writes()).toMatchObject([{ path: "class/substituteclassteacher", body: { ClassId: 19167, StaffId: Number(replacement.replace("mb-staff-", "")) } }]);
});
it("pushes consecutive customer moves using the last booked class, retaining the earlier change", async () => {
  const { original } = await realCover();
  const link = repository.listCustomerLinks(id).find((row) => row.kind === "choice" && state().bookings.find((booking) => booking.id === row.bookingId)?.entitlement?.kind === "pack")!;
  const token = repository.customerToken(link), b = (await customerChoice(token, repository)).alternatives[0].id;
  await submitChoice(token, { action: "move", sessionId: b }, repository);
  expect((await pushToMindbody(id, repository, api.client)).applied).toBe(1);
  const first = feed.allChanges(id, repository).find((row) => row.id.startsWith(`choice:${link.id}:`))!;
  const c = (await customerChoice(token, repository)).alternatives.find((row) => row.id !== original.id)!.id;
  await submitChoice(token, { action: "move", sessionId: c }, repository); api.calls.length = 0;
  expect(await pushToMindbody(id, repository, api.client)).toMatchObject({ applied: 1, failed: [], pending: 0 });
  const mapping = repository.mindbodyLink(id)!.sessions;
  expect(writes()).toMatchObject([{ path: "class/removeclientfromclass", body: { ClassId: mapping[b].classId } }, { path: "class/addclienttoclass", body: { ClassId: mapping[c].classId } }]);
  expect(feed.allChanges(id, repository)).toContainEqual(first);
});
it("recreates a moved class, moves its active bookings with services and suppresses dependent booking moves", async () => {
  const before = session(), after = { ...before, start: "2026-11-02T19:15:00.000Z", end: "2026-11-02T20:15:00.000Z" };
  const sessionId = `plan:p:session:${before.id}`;
  changes.push({ ...base(`plan:p:booking:${state().bookings[0].id}`), type: "booking.moved", bookingId: state().bookings[0].id, customer: person(), from: before, to: after },
    { ...base(sessionId), type: "session.moved", session: after, before, after });
  expect(await pushToMindbody(id, repository, api.client)).toMatchObject({ applied: 2, failed: [], pending: 0 });
  const sent = writes(), newId = repository.mindbodyLink(id)!.sessions[before.id].classId;
  expect(newId).not.toBe(19167);
  expect(sent.map((row) => row.path)).toEqual(["class/addclassschedule", "class/addclienttoclass", "class/addclienttoclass", "class/addclienttoclass", "class/cancelsingleclass"]);
  expect(sent[0].body).toMatchObject({ ClassDescriptionId: 257, StartDate: "2026-11-02", EndDate: "2026-11-02", StartTime: "1900-01-01T11:15:00", EndTime: "1900-01-01T12:15:00", DayMonday: true, DayTuesday: false, ResourceId: 1, StaffPayRate: 1, MaxCapacity: 30 });
  expect(sent[1].body).toMatchObject({ ClassId: newId, ClientServiceId: 100257556, RequirePayment: false, SendEmail: false, Waitlist: false });
  expect(sent.at(-1)?.body).toEqual({ ClassID: 19167, SendClientEmail: false, SendStaffEmail: false });
  expect((await pullFromMindbody(id, repository, api.client)).results).toEqual([]);
  const count = sent.length; await pushToMindbody(id, repository, api.client); expect(writes()).toHaveLength(count);
});
it("resumes a move after a booking failure without creating another schedule", async () => {
  const before = session(), after = { ...before, start: "2026-11-02T19:15:00.000Z", end: "2026-11-02T20:15:00.000Z" };
  changes.push({ ...base(), type: "session.moved", session: after, before, after });
  api.hook = (call) => call.path === "class/addclienttoclass" ? reply({ Error: { Message: "Booking unavailable" } }, 400) : undefined;
  expect((await pushToMindbody(id, repository, api.client)).failed).toEqual([{ id: "one", message: "Booking unavailable" }]);
  expect(repository.syncAcks(id).size).toBe(0);
  api.hook = undefined;
  expect((await pushToMindbody(id, repository, api.client)).applied).toBe(1);
  expect(writes().filter((row) => row.path === "class/addclassschedule")).toHaveLength(1);
});
it("discovers a schedule after a lost creation response and never blindly posts a second one", async () => {
  const before = session(), after = { ...before, start: "2026-11-02T19:15:00.000Z", end: "2026-11-02T20:15:00.000Z" };
  changes.push({ ...base(), type: "session.moved", session: after, before, after });
  api.hook = (call) => {
    if (call.path !== "class/addclassschedule") return;
    api.classes.push({ ...structuredClone(api.classes[0]), Id: 9999, StartDateTime: "2026-11-02T11:15:00", EndDateTime: "2026-11-02T12:15:00", TotalBooked: 0 });
    return reply({ Error: { Message: "Upstream response lost" } }, 503);
  };
  expect((await pushToMindbody(id, repository, api.client)).pending).toBe(1);
  api.hook = undefined;
  expect((await pushToMindbody(id, repository, api.client)).applied).toBe(1);
  expect(repository.mindbodyLink(id)!.sessions[before.id].classId).toBe(9999);
  expect(writes().filter((row) => row.path === "class/addclassschedule")).toHaveLength(1);
});
it("does not try to recreate a class whose Mindbody class description is inactive", async () => {
  const before = session(), after = { ...before, start: "2026-11-02T19:15:00.000Z", end: "2026-11-02T20:15:00.000Z" };
  const link = repository.mindbodyLink(id)!; link.sessions[before.id].inactive = true; repository.saveMindbodyLink(id, link);
  changes.push({ ...base(), type: "session.moved", session: after, before, after });
  const result = await pushToMindbody(id, repository, api.client);
  expect(result).toMatchObject({ applied: 0, pending: 1 }); expect(result.failed[0].message).toMatch(/no longer schedules new .* by hand/);
  expect(writes()).toEqual([]);
});
it("moves a customer's booking between classes, cancels on time and confirms returned packs", async () => {
  const booking = state().bookings[0];
  changes.push({ ...base("move"), type: "booking.moved", bookingId: booking.id, customer: person(), from: session(), to: session(1) },
    { ...base("cancel"), type: "booking.cancelled", bookingId: booking.id, customer: person(), session: session(1), reason: "cancelled" },
    { ...base("pack"), type: "pack.visit_returned", bookingId: booking.id, customer: person(), visitsLeftAfter: 8 });
  expect((await pushToMindbody(id, repository, api.client)).applied).toBe(3);
  expect(writes().map((row) => row.path)).toEqual(["class/removeclientfromclass", "class/addclienttoclass", "class/removeclientfromclass"]);
  expect(writes()[0].body).toEqual({ ClientId: "100015648", ClassId: 19167, LateCancel: false, SendEmail: false });
  expect(api.calls.some((row) => row.path === "client/clientservices")).toBe(true);
});
it.each(["Client already in class", "Client not in class", "Class already cancelled"])("treats %s as an applied retry", async (message) => {
  const type = message.includes("already in") ? "booking.created" : message.includes("not in") ? "booking.cancelled" : "session.cancelled";
  if (type === "session.cancelled") changes.push({ ...base(), type, session: session() });
  else if (type === "booking.created") changes.push({ ...base(), type, session: session(), bookingId: "new", customer: person(), source: "checkout", amount: "20.00" });
  else changes.push({ ...base(), type, session: session(), bookingId: "new", customer: person(), reason: "cancelled" });
  api.hook = (call) => call.body ? reply({ Error: { Message: message } }, 400) : undefined;
  expect((await pushToMindbody(id, repository, api.client)).applied).toBe(1);
});
it("finds clients by exact email and creates missing ones before booking", async () => {
  changes.push({ ...base(), type: "booking.created", session: session(1), bookingId: "new", customer: { id: "local", name: "Sky Quinn", email: "sky@example.com" }, source: "checkout", amount: "20.00" });
  expect((await pushToMindbody(id, repository, api.client)).applied).toBe(1);
  expect(writes()[0]).toMatchObject({ path: "client/addclient", body: { FirstName: "Sky", LastName: "Quinn", Email: "sky@example.com", SendEmail: false } });
  expect(writes()[1].body).toMatchObject({ ClientId: repository.mindbodyLink(id)!.clients.local, RequirePayment: false });
});
it("keeps failures pending, acknowledges only success, sanitizes errors and holds a workspace connector lease", async () => {
  changes.push({ ...base("bad"), type: "session.cancelled", session: session() }, { ...base("good"), type: "session.cancelled", session: session(1) });
  api.hook = (call) => call.body?.ClassID === 19167 ? reply({ Error: { Message: "Denied fixture-api-key fixture-staff-token" } }, 403) : undefined;
  expect(await pushToMindbody(id, repository, api.client)).toEqual({ applied: 1, pending: 1, failed: [{ id: "bad", message: "Denied [redacted] [redacted]" }] });
  expect([...repository.syncAcks(id)]).toEqual(["good"]);
  repository.acquireMindbodyLock(id, "other"); await expect(pushToMindbody(id, repository, api.client)).rejects.toThrow("already running");
  repository.releaseMindbodyLock(id, "other");
});
it("never asks Mindbody for a waitlist larger than a small class, which it rejects", () => {
  const mapping = { classId: 1, descriptionId: 2, locationId: 3, staffId: 4 }, base = { id: "s", classType: "yoga" as const, title: "Yoga", capacity: 6, price: "20.00", roomId: "r", instructorId: "i", start: "2026-11-09T14:00:00.000Z", end: "2026-11-09T15:00:00.000Z" };
  expect(oneOff(base, mapping, "America/New_York")).toMatchObject({ MaxCapacity: 6, WaitlistCapacity: 6 });
  expect(oneOff({ ...base, capacity: 20 }, mapping, "America/New_York")).toMatchObject({ MaxCapacity: 20, WaitlistCapacity: 10 });
});
