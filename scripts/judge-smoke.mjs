import { pathToFileURL } from "node:url";

const DEFAULT_BASE = "https://rebook-by9u.onrender.com";

/** Require matching booking and completed ledger evidence from Maya's Monday scenario. */
export function scenarioCapture(workspace) {
  const { state, ledger } = workspace;
  const maya = state.instructors.find((instructor) => instructor.name === "Maya Chen");
  if (!maya) throw new Error("Maya's disruption scenario is missing");
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, weekday: "long" });
  const sessions = new Set(state.sessions.filter((session) => session.instructorId === maya.id && weekday.format(new Date(session.start)) === "Monday").map((session) => session.id));
  return state.bookings.find((booking) => sessions.has(booking.sessionId) && booking.payment?.simulated === false && !booking.payment.unknown &&
    typeof booking.payment.captureId === "string" && booking.payment.captureId.length > 0 && !/^(SEED-|SIMULATED)/i.test(booking.payment.captureId) &&
    ledger.some((event) => event.kind === "capture" && event.status === "COMPLETED" && event.bookingId === booking.id &&
      event.captureId === booking.payment.captureId && event.paypalId === booking.payment.captureId && event.amount === booking.amount && Number(event.amount) > 0));
}

export async function runJudgeSmoke({ base = DEFAULT_BASE, fetchImpl = fetch, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const origin = new URL(base);
  if (!["http:", "https:"].includes(origin.protocol)) throw new Error("Smoke base must use HTTP or HTTPS");
  const started = now(), deadline = started + 360_000;
  const request = async (path, init = {}, until = deadline) => {
    const remaining = Math.min(until, deadline) - now();
    if (remaining <= 0) throw new Error(`Smoke time budget exceeded at ${path}`);
    return fetchImpl(new URL(path, origin), { ...init, cache: "no-store", signal: AbortSignal.timeout(Math.min(60_000, remaining)) });
  };
  const pause = async (ms, until) => { if (now() < until) await sleep(Math.min(ms, until - now())); };
  let awake = false, lastError = "no response";
  const wakeDeadline = started + 180_000;
  for (let attempt = 0; now() < wakeDeadline; attempt += 1) {
    try {
      const response = await request("/api/health", {}, wakeDeadline);
      awake = response.status === 200;
      lastError = `HTTP ${response.status}`;
      await response.body?.cancel();
      if (awake) break;
    } catch (error) { lastError = error.message; }
    await pause(Math.min(15_000, 2000 * 2 ** attempt), wakeDeadline);
  }
  if (!awake) throw new Error(`Health did not become ready within 3 minutes: ${lastError}`);
  // One creation request only: retries could create extra workspaces after an uncertain response.
  const created = await request("/api/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (created.status !== 202) throw new Error(`Workspace creation failed: HTTP ${created.status}`);
  const { id } = await created.json();
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{10}$/.test(id)) throw new Error("Workspace creation returned an invalid id");
  const readyDeadline = Math.min(now() + 120_000, deadline);
  let workspace;
  while (now() < readyDeadline) {
    try {
      const response = await request(`/api/workspaces/${id}`, {}, readyDeadline);
      if (response.status >= 500 || response.status === 429) { lastError = `HTTP ${response.status}`; await response.body?.cancel(); }
      else {
        if (response.status !== 200) throw new Error(`Workspace read failed: HTTP ${response.status}`);
        workspace = await response.json();
        if (workspace.status === "ready") break;
        if (workspace.status !== "preparing") throw new Error(`Workspace ${id} ended in ${workspace.status}: ${workspace.preparationError || "preparation failed"}`);
        lastError = "still preparing";
      }
    } catch (error) {
      // Transport errors can recover; API errors and terminal preparation states must fail.
      if (!(error instanceof TypeError) && error.name !== "TimeoutError") throw error;
      lastError = error.message;
    }
    await pause(3000, readyDeadline);
  }
  if (workspace?.status !== "ready") throw new Error(`Workspace ${id} was not ready within 2 minutes: ${lastError}`);
  const booking = scenarioCapture(workspace);
  if (!booking) throw new Error(`Workspace ${id} has no real completed PayPal sandbox capture for Maya's Monday scenario`);
  if (typeof workspace.bookingId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(workspace.bookingId)) throw new Error("Workspace returned an invalid public booking id");
  const pages = [`/w/${id}`, `/b/${workspace.bookingId}`, `/w/${id}/dashboard`];
  for (const path of pages) {
    const response = await request(path);
    const status = response.status;
    await response.text();
    if (status !== 200) throw new Error(`Page ${path} failed: HTTP ${status}`);
  }
  return { ok: true, base: origin.origin, workspaceId: id, captureId: booking.payment.captureId, pages: pages.length, elapsedMs: now() - started };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runJudgeSmoke({ base: process.argv[2] || process.env.JUDGE_SMOKE_BASE || DEFAULT_BASE }))); }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
