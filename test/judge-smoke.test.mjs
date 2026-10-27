import { expect, it, vi } from "vitest";
import { runJudgeSmoke, scenarioCapture } from "../scripts/judge-smoke.mjs";

function fixture() {
  return { bookingId: "0123456789abcdefghijklmnopqrstuv", status: "ready", state: { studio: { timezone: "America/New_York" }, instructors: [{ id: "maya", name: "Maya Chen" }],
    sessions: [{ id: "yoga", instructorId: "maya", start: "2026-11-09T12:00:00Z" }],
    bookings: [{ id: "booking", sessionId: "yoga", amount: "25.00", payment: { simulated: false, captureId: "9AB12345CD678901EF" } }] },
  ledger: [{ kind: "capture", status: "COMPLETED", bookingId: "booking", amount: "25.00", captureId: "9AB12345CD678901EF", paypalId: "9AB12345CD678901EF" }] };
}

function harness(workspace = fixture()) {
  let time = 0;
  const fetchImpl = vi.fn(async (url) => {
    if (url.pathname === "/api/health") return new Response("ok");
    if (url.pathname === "/api/workspaces") return Response.json({ id: "abcdefghij" }, { status: 202 });
    if (url.pathname === "/api/workspaces/abcdefghij") return Response.json(workspace);
    return new Response("<html>Page</html>");
  });
  return { fetchImpl, now: () => time, sleep: async (ms) => { time += ms; }, base: "https://example.com" };
}

it("wakes, creates one workspace and checks real capture evidence and all three pages", async () => {
  const h = harness();
  h.fetchImpl.mockResolvedValueOnce(new Response("Waking", { status: 503 }));
  expect(await runJudgeSmoke(h)).toMatchObject({ ok: true, workspaceId: "abcdefghij", pages: 3, captureId: "9AB12345CD678901EF" });
  expect(h.fetchImpl.mock.calls.map(([url]) => url.pathname)).toEqual(["/api/health", "/api/health", "/api/workspaces", "/api/workspaces/abcdefghij", "/w/abcdefghij", "/b/0123456789abcdefghijklmnopqrstuv", "/w/abcdefghij/dashboard"]);
  expect(h.fetchImpl.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
});

it.each(["simulated", "seed", "missing-id", "pending", "mismatch", "wrong-scenario"])("rejects %s capture evidence", (kind) => {
  const workspace = fixture();
  if (kind === "simulated") workspace.state.bookings[0].payment.simulated = true;
  if (kind === "seed") workspace.state.bookings[0].payment.captureId = "SEED-CAP-1";
  if (kind === "missing-id") workspace.state.bookings[0].payment.captureId = "";
  if (kind === "pending") workspace.ledger[0].status = "PENDING";
  if (kind === "mismatch") workspace.ledger[0].captureId = "other";
  if (kind === "wrong-scenario") workspace.state.sessions[0].start = "2026-11-10T12:00:00Z";
  expect(scenarioCapture(workspace)).toBeUndefined();
});

it("fails on simulated-only preparation, terminal errors, page errors and preparation timeouts", async () => {
  const simulated = fixture(); simulated.state.bookings[0].payment.simulated = true;
  await expect(runJudgeSmoke(harness(simulated))).rejects.toThrow("no real completed PayPal sandbox capture");
  await expect(runJudgeSmoke(harness({ status: "failed", preparationError: "Capture failed" }))).rejects.toThrow("ended in failed: Capture failed");
  await expect(runJudgeSmoke(harness({ status: "preparing" }))).rejects.toThrow("within 2 minutes");
  const h = harness();
  const original = h.fetchImpl.getMockImplementation();
  h.fetchImpl.mockImplementation((url, init) => url.pathname.endsWith("/dashboard") ? new Response("Error", { status: 500 }) : original(url, init));
  await expect(runJudgeSmoke(h)).rejects.toThrow("dashboard failed: HTTP 500");
});

it("stops health retries after three minutes and never repeats workspace creation", async () => {
  const h = harness();
  h.fetchImpl.mockResolvedValue(new Response("Unavailable", { status: 503 }));
  await expect(runJudgeSmoke(h)).rejects.toThrow("within 3 minutes");
  expect(h.now()).toBe(180_000);
  const creation = harness();
  creation.fetchImpl.mockResolvedValueOnce(new Response("ok")).mockRejectedValueOnce(new TypeError("Disconnected"));
  await expect(runJudgeSmoke(creation)).rejects.toThrow("Disconnected");
  expect(creation.fetchImpl).toHaveBeenCalledTimes(2);
});
