import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspace, resetWorkspace, WorkspaceCreationError } from "../lib/demo/createWorkspace";
import { localParts } from "../lib/domain/time";
import { Repository } from "../lib/store";
import { seedStudio } from "../lib/seed/seed";

let directory: string;
let repository: Repository;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rebook-workspace-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  vi.stubEnv("PAYPAL_CLIENT_ID", randomUUID());
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "mock-secret");
  repository = new Repository();
});
afterEach(() => {
  repository.close(); rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function mockedCaptures(failFirst = false) {
  let active = 0;
  let maxActive = 0;
  let count = 0;
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/token")) return Response.json({ access_token: "token", expires_in: 3600 });
    const number = ++count;
    active += 1; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    if (failFirst && number === 1) return Response.json({ name: "UNPROCESSABLE_ENTITY", message: "Declined" }, { status: 422 });
    const key = (init!.headers as Record<string, string>)["PayPal-Request-Id"];
    return Response.json({ id: `order-${key}`, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: `capture-${key}`, status: "COMPLETED" }] } }] }, { status: 201, headers: { "paypal-debug-id": `debug-${number}` } });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, maxActive: () => maxActive };
}
describe("workspace seeding", () => {
  it("can seed entirely simulated payments without credentials or network", async () => {
    vi.stubEnv("DEMO_REAL_CAPTURES", "0");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const progress = vi.fn();
    const workspace = await createWorkspace({ repository, onProgress: progress });
    expect(workspace.id).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(workspace.state.bookings.length).toBe(seedStudio().bookings.length);
    expect(workspace.state.bookings.every((booking) => booking.payment?.simulated && booking.payment.captureId.startsWith("SEED-"))).toBe(true);
    expect(repository.listLedger(workspace.id)).toHaveLength(workspace.state.bookings.length);
    expect(repository.listLedger(workspace.id).every((event) => event.status === "SIMULATED")).toBe(true);
    expect(progress).toHaveBeenCalledTimes(workspace.state.bookings.length);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("captures only the first two studio-local days with concurrency four", async () => {
    vi.stubEnv("DEMO_REAL_CAPTURES", "1");
    const { fetch, maxActive } = mockedCaptures();
    const workspace = await createWorkspace({ repository });
    const realSessions = workspace.state.sessions.filter((session) => ["2026-11-09", "2026-11-10"].includes(localParts(session.start, workspace.state.studio.timezone).dateKey));
    const realIds = new Set(realSessions.map((session) => session.id));
    const realBookings = workspace.state.bookings.filter((booking) => realIds.has(booking.sessionId));
    expect(realBookings.length).toBeGreaterThan(0);
    expect(realBookings.every((booking) => booking.payment?.simulated === false && booking.payment.captureId.startsWith("capture-"))).toBe(true);
    expect(workspace.state.bookings.filter((booking) => !realIds.has(booking.sessionId)).every((booking) => booking.payment?.simulated)).toBe(true);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/orders"))).toHaveLength(realBookings.length);
    expect(maxActive()).toBe(4);
    for (const booking of realBookings) {
      expect(repository.latestMoneyEvents(workspace.id).find((event) => event.bookingId === booking.id)).toMatchObject({
        kind: "capture", status: "COMPLETED", amount: booking.amount, paypalId: booking.payment!.captureId, requestId: `${workspace.id}${booking.id}`,
      });
    }
  });
  it("preserves successful captures and reports the workspace ID when a capture fails", async () => {
    vi.stubEnv("DEMO_REAL_CAPTURES", "1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockedCaptures(true);
    let failure: WorkspaceCreationError | undefined;
    try { await createWorkspace({ repository }); }
    catch (error) { expect(error).toBeInstanceOf(WorkspaceCreationError); failure = error as WorkspaceCreationError; }
    expect(failure).toBeDefined();
    const ledger = repository.latestMoneyEvents(failure!.workspaceId);
    expect(ledger.filter((event) => event.status === "FAILED")).toHaveLength(1);
    expect(ledger.filter((event) => event.status === "COMPLETED").length).toBeGreaterThan(0);
  });
  it("resets with fresh capture keys and booking IDs while retaining the money ledger", async () => {
    vi.stubEnv("DEMO_REAL_CAPTURES", "1");
    mockedCaptures();
    const first = await createWorkspace({ repository });
    const firstIds = new Set(first.state.bookings.map((booking) => booking.id));
    const captures = repository.latestMoneyEvents(first.id).filter((event) => event.status === "COMPLETED");
    const reset = await resetWorkspace(first.id, { repository });
    expect(reset.id).toBe(first.id);
    expect(reset.state.bookings.every((booking) => !firstIds.has(booking.id))).toBe(true);
    const nextCaptures = repository.latestMoneyEvents(first.id).filter((event) => event.status === "COMPLETED");
    expect(nextCaptures).toHaveLength(captures.length * 2);
    expect(new Set(nextCaptures.map((event) => event.paypalId)).size).toBe(captures.length * 2);
  });
});
