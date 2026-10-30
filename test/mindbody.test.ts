import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MindbodyClient } from "../lib/connectors/mindbody/client";
import { createMindbodyWorkspace, localInstant, mindbodyClassType, mindbodyWeek } from "../lib/connectors/mindbody/import";
import { StateSchema } from "../lib/domain/schemas";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import { replan } from "../lib/solver/replan";
import { validate } from "../lib/solver/validate";
import { sandbox, reply, fixture } from "./mindbody-fixture";

let directory: string, repository: Repository;
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-30T12:00:00Z")); directory = mkdtempSync(join(tmpdir(), "rebook-mindbody-")); vi.stubEnv("DATA_DIR", directory); repository = getRepository(); });
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });
it("imports recorded sandbox shapes into a valid solver state with stable ids, rooms, entitlements and assumptions", async () => {
  const api = sandbox(); const result = await mindbodyWeek(api.client);
  expect(StateSchema.safeParse(result.state).success).toBe(true);
  expect(result.link).toMatchObject({ siteId: -99, locationId: 1, week: "2026-11-02" });
  expect(result.state.studio.timezone).toBe("America/Los_Angeles");
  expect(result.state.sessions[0]).toMatchObject({ id: "mb-class-19167", start: "2026-11-02T17:15:00.000Z", instructorId: "mb-staff-100000237", roomId: "mb-room-1", classType: "hiit", price: "20.00" });
  expect(result.state.rooms.find((row) => row.id === "mb-room-loc-1-1")?.name).toBe("Harbor Studio 1 space 1");
  for (const room of result.state.rooms) expect(room.capacity).toBe(Math.max(...result.state.sessions.filter((row) => row.roomId === room.id).map((row) => row.capacity)));
  for (const staff of result.state.instructors) expect(staff.skills).toEqual([...new Set(result.state.sessions.filter((row) => row.instructorId === staff.id).map((row) => row.classType))]);
  expect(result.state.bookings[0]).toMatchObject({ id: "mb-visit-100343877", customerId: "mb-client-100015648", amount: "0.00", entitlement: { kind: "pack", visitsLeft: 7, expires: "2026-12-29" } });
  expect(result.warnings.join(" ")).toMatch(/Fitness Assessments.*Beginner Swim/);
  expect(result.warnings.join(" ")).toContain("$20.00");
  expect(api.calls.filter((row) => row.path === "class/classvisits")).toHaveLength(1);
  expect(api.calls.filter((row) => row.path === "client/clientservices")).toHaveLength(2);
  const session = result.state.sessions[0], disruption = { kind: "instructor_unavailable" as const, instructorId: session.instructorId, from: session.start, to: session.end };
  const plan = replan(result.state, disruption, { now: "2026-10-30T12:00:00Z" });
  expect(validate(result.state, plan)).toEqual({ ok: true, errors: [] });
});
it.each([["Power Yoga", "yoga"], ["Level 5 Bikram Yoga", "yoga"], ["Reformer Pilates", "pilates"], ["Pilates 101", "pilates"], ["RPM Spinning", "spin"], ["Zumba", "dance"], ["Body Jam", "dance"], ["Body Pump", "hiit"], ["Bottoms Up", "hiit"], ["Sweat", "hiit"], ["crossfit level 1", "hiit"], ["Six Week Boot Camp", "hiit"], ["TRX Small Group", "hiit"], ["Daily Work Out", "hiit"], ["Kids Yoga", undefined], ["Semi-private", undefined]])("maps %s to %s", (name, type) => expect(mindbodyClassType(name!)).toBe(type));
it("uses site local dates including the DST overlap and defaults to Monday on Monday", async () => {
  expect(localInstant("2026-11-01T01:30:00", "America/Los_Angeles")).toBe("2026-11-01T08:30:00.000Z");
  expect(localInstant("2026-11-01T02:30:00", "America/Los_Angeles")).toBe("2026-11-01T10:30:00.000Z");
  expect((await mindbodyWeek(sandbox().client, {}, new Date("2026-11-02T17:00:00Z"))).link.week).toBe("2026-11-02");
  await expect(mindbodyWeek(sandbox().client, { weekStart: "2026-11-01" })).rejects.toThrow();
});
it("honors location choice, skips cancelled classes and late cancels, and reads membership names", async () => {
  const api = sandbox(); api.classes[0].IsCanceled = true;
  expect((await mindbodyWeek(api.client, { locationId: 2 })).state.sessions.map((row) => row.classType)).toEqual(["dance"]);
  const another = sandbox(); another.visits[19167][0].LateCancelled = true;
  another.visits[19167][1].ServiceName = "Unlimited membership";
  const result = await mindbodyWeek(another.client);
  expect(result.state.bookings).toHaveLength(2); expect(result.state.bookings[0].entitlement?.kind).toBe("membership");
});
it("shares CSV simulated-capture creation and persists/clears the workspace link", async () => {
  const { id } = await createMindbodyWorkspace({}, repository, sandbox().client);
  const state = repository.requireWorkspace(id).state;
  expect(repository.mindbodyLink(id)?.locationId).toBe(1);
  expect(repository.listLedger(id)).toHaveLength(state.bookings.filter((row) => !row.entitlement).length);
  expect(repository.listLedger(id).every((row) => row.status === "SIMULATED")).toBe(true);
  repository.clearPlans(id); expect(repository.mindbodyLink(id)).toBeUndefined();
});
it("surfaces waitlist read failures as a warning without inventing entries", async () => {
  const api = sandbox(); api.hook = (call) => call.path === "class/waitlistentries" ? reply(fixture("waitlist-error"), 400) : undefined;
  expect((await mindbodyWeek(api.client)).warnings.join(" ")).toContain("Waitlists were not imported");
});
it("reissues a staff token once on 401, retries 429/5xx once, sends headers, and paginates", async () => {
  const api = sandbox(); let attempts = 0, tokenIssues = 0;
  api.hook = (call) => {
    if (call.path === "usertoken/issue") tokenIssues++;
    if (call.path === "site/sites" && attempts++ === 0) return reply({ Error: { Message: "Expired token" } }, 401);
  };
  await api.client.list("site/sites", "Sites"); expect(tokenIssues).toBe(2);
  const call = api.calls.at(-1)!; expect(call.headers.get("Api-Key")).toBe("fixture-api-key"); expect(call.headers.get("SiteId")).toBe("-99"); expect(call.headers.get("Authorization")).toBe("fixture-staff-token");
  for (const status of [429, 503]) {
    attempts = 0; api.hook = (call) => call.path === "site/sites" && attempts++ === 0 ? reply({}, status) : undefined;
    await api.client.list("site/sites", "Sites"); expect(attempts).toBe(2);
  }
  api.hook = (call) => call.path === "many" ? reply({ Rows: Array.from({ length: Number(call.query.get("Offset")) ? 1 : 200 }, (_, id) => ({ id })), PaginationResponse: { TotalResults: 201 } }) : undefined;
  expect(await api.client.list("many", "Rows")).toHaveLength(201);
});
it("bounds calls, never forwards secrets in Mindbody errors, and does not leak transport error text", async () => {
  const api = sandbox(); api.hook = (call) => call.path === "site/sites" ? reply({ Error: { Message: "Rejected fixture-api-key fixture-staff-token Apitest1234" } }, 403) : undefined;
  await expect(api.client.list("site/sites", "Sites")).rejects.toThrow("Rejected [redacted] [redacted] [redacted]");
  const limited = new MindbodyClient({ apiKey: "secret", maxCalls: 1, fetch: api.transport });
  await expect(limited.list("site/sites", "Sites")).rejects.toThrow("call budget exceeded");
  const unreachable = new MindbodyClient({ apiKey: "secret", fetch: async () => { throw new Error("secret"); } });
  await expect(unreachable.list("site/sites", "Sites")).rejects.toThrow("Mindbody could not be reached");
});
