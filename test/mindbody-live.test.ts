// Opt-in check against Mindbody's shared sandbox (it writes there; the sandbox resets nightly). Run: MINDBODY_LIVE=1 MINDBODY_API_KEY=... npx vitest run test/mindbody-live.test.ts --silent=false
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { MindbodyClient } from "../lib/connectors/mindbody/client";
import { createMindbodyWorkspace } from "../lib/connectors/mindbody/import";
import { pushToMindbody } from "../lib/connectors/mindbody/push";
import { pullFromMindbody } from "../lib/connectors/mindbody/pull";
import { pendingChanges } from "../lib/sync/feed";
import { replan } from "../lib/solver/replan";
import { executePlan } from "../lib/executor/executePlan";
import { getRepository } from "../lib/store";
import { addLocalDays, localParts, zonedTimeToUtc } from "../lib/domain/time";

it.skipIf(!process.env.MINDBODY_LIVE)("runs the full loop against the Mindbody sandbox", async () => {
  vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "rebook-mb-live-")));
  const repository = getRepository(), client = new MindbodyClient({ apiKey: process.env.MINDBODY_API_KEY });
  const created = await createMindbodyWorkspace({ weekStart: "2026-11-02" }, repository, client);
  console.log("IMPORT", JSON.stringify(created.summary), "\nWARN", created.warnings.join(" | "), "\ncalls", client.calls);
  const id = created.id, state = repository.requireWorkspace(id).state, tz = state.studio.timezone;
  const booked = state.sessions.map((s) => ({ s, n: state.bookings.filter((b) => b.sessionId === s.id).length })).sort((a, b) => b.n - a.n)[0].s;
  const instructor = state.instructors.find((row) => row.id === booked.instructorId)!, date = localParts(booked.start, tz).dateKey;
  const disruption = process.env.MB_CLOSURE ? { kind: "closure" as const, from: new Date(Date.parse(booked.start) - 15 * 60000).toISOString(), to: new Date(Date.parse(booked.end) + 15 * 60000).toISOString(), reason: "Burst pipe" } : { kind: "instructor_unavailable" as const, instructorId: instructor.id, from: zonedTimeToUtc(date, "00:00", tz), to: zonedTimeToUtc(addLocalDays(date, 1), "00:00", tz), reason: `${instructor.name} is sick` };
  const plan = repository.createPlan(id, replan(state, disruption));
  console.log("PLAN", instructor.name, date, JSON.stringify(plan.totals), plan.sessionChanges.map((c) => `${c.sessionId}:${c.remedy}`).join(","));
  await executePlan(id, plan.id, repository);
  console.log("PENDING", pendingChanges(id, repository).map((c) => c.type).join(","));
  const push = await pushToMindbody(id, repository, client);
  console.log("PUSH", JSON.stringify(push), "calls", client.calls);
  const link = repository.mindbodyLink(id)!;
  for (const change of plan.sessionChanges) {
    const mapped = link.sessions[change.sessionId];
    const day = localParts((change.after ?? change.before).start, tz).dateKey;
    const rows = (await client.list<{ Id: number; StartDateTime: string; Staff: { DisplayName?: string; FirstName?: string }; IsCanceled: boolean; TotalBooked: number; Resource?: { Name: string } }>("class/classes", "Classes", { StartDateTime: `${day}T00:00:00`, EndDateTime: `${day}T23:59:59` })).filter((r) => r.Id === mapped.classId || r.Id === Number(change.sessionId.replace("mb-class-", "")));
    console.log("MINDBODY", change.sessionId, change.remedy, "->", JSON.stringify(rows.map((r) => [r.Id, r.StartDateTime, r.Staff.DisplayName ?? r.Staff.FirstName, r.Resource?.Name, r.IsCanceled, r.TotalBooked])));
  }
  console.log("PULL (expect no echo)", JSON.stringify(await pullFromMindbody(id, repository, client)));
  // An outside change in Mindbody: book an imported client into another future class directly.
  const fresh = repository.requireWorkspace(id).state;
  const target = fresh.sessions.find((s) => Date.parse(s.start) > Date.now() && !plan.sessionChanges.some((c) => c.sessionId === s.id) && fresh.bookings.filter((b) => b.sessionId === s.id).length < s.capacity)!;
  const customer = fresh.customers.find((c) => !fresh.bookings.some((b) => b.sessionId === target.id && b.customerId === c.id))!;
  const clientId = customer.id.replace("mb-client-", ""), classId = repository.mindbodyLink(id)!.sessions[target.id].classId;
  await client.request("class/addclienttoclass", { ClientId: clientId, ClassId: classId, RequirePayment: false, Waitlist: false, SendEmail: false });
  const pulled = await pullFromMindbody(id, repository, client);
  console.log("PULL after outside booking", JSON.stringify(pulled));
  console.log("REBOOK has booking:", repository.requireWorkspace(id).state.bookings.some((b) => b.sessionId === target.id && b.customerId === customer.id && b.status === "confirmed"));
  expect(push.failed).toEqual([]);
}, 300_000);
