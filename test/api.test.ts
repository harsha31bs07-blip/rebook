import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as create } from "../app/api/workspaces/route";
import { GET as read } from "../app/api/workspaces/[id]/route";
import { POST as propose } from "../app/api/workspaces/[id]/plans/route";
import { POST as approve } from "../app/api/workspaces/[id]/plans/[planId]/approve/route";
import { POST as reset } from "../app/api/workspaces/[id]/reset/route";
import { demoDisruption } from "../lib/seed/seed";
import { closeRepository } from "../lib/store";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rebook-api-"));
  vi.stubEnv("DATA_DIR", directory); vi.stubEnv("DEMO_REAL_CAPTURES", "0");
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  closeRepository(); rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function post(body: unknown = {}, ip = randomUUID()) {
  return new Request("http://localhost/api/workspaces", { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
describe("workspace API", () => {
  it("creates, reads, plans, approves idempotently and resets an isolated workspace", async () => {
    const response = await create(post());
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const readResponse = await read(new Request("http://localhost"), context(id));
    expect(readResponse.status).toBe(200);
    expect((await readResponse.json()).state.bookings.length).toBeGreaterThan(0);
    const proposal = await propose(post({ disruption: demoDisruption }), context(id));
    expect(proposal.status).toBe(200);
    const plan = await proposal.json();
    expect(plan.status).toBe("proposed");
    const approvalContext = { params: Promise.resolve({ id, planId: plan.id }) };
    const execution = await approve(post(), approvalContext);
    expect(execution.status).toBe(200);
    expect((await execution.json()).plan.status).toBe("executed");
    expect((await approve(post(), approvalContext)).status).toBe(200);
    const resetResponse = await reset(post(), context(id));
    expect(await resetResponse.json()).toEqual({ id });
    const afterReset = await (await read(new Request("http://localhost"), context(id))).json();
    expect(afterReset.plans).toEqual([]);
    expect(afterReset.state.bookings.every((booking: { status: string }) => booking.status === "confirmed")).toBe(true);
  });
  it("validates inputs and returns sanitized errors", async () => {
    expect((await create(post({ unexpected: true }))).status).toBe(400);
    expect((await create(new Request("http://localhost", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await read(new Request("http://localhost"), context("bad"))).status).toBe(400);
    const missing = await read(new Request("http://localhost"), context("missing123"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Workspace not found" });
    const { id } = await (await create(post())).json();
    expect((await propose(post({ disruption: { kind: "closure" } }), context(id))).status).toBe(400);
    expect((await approve(post(), { params: Promise.resolve({ id, planId: randomUUID() }) })).status).toBe(404);
  });
  it("limits creation and reset calls together to five per IP per hour", async () => {
    const ip = randomUUID();
    const { id } = await (await create(post({}, ip))).json();
    for (let index = 0; index < 4; index += 1) expect((await reset(post({}, ip), context(id))).status).toBe(200);
    expect((await create(post({}, ip))).status).toBe(429);
    expect((await reset(post({}, ip), context(id))).status).toBe(429);
    expect((await create(post())).status).toBe(201);
  });
});
