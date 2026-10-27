import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeRepository, getRepository } from "../lib/store";
import { limits } from "../lib/api/limits";
import { demoDisruption, seedStudio } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { GET as publicCatalog } from "../app/api/bookings/[bookingId]/checkout/route";
import { GET as ownerRead } from "../app/api/workspaces/[id]/route";
import { POST as plan } from "../app/api/workspaces/[id]/plans/route";
import { GET as details, DELETE as discard } from "../app/api/workspaces/[id]/plans/[planId]/route";
import { POST as adjust } from "../app/api/workspaces/[id]/plans/[planId]/adjust/route";
import { POST as approve } from "../app/api/workspaces/[id]/plans/[planId]/approve/route";
import { POST as interpret } from "../app/api/workspaces/[id]/interpret/route";
import { POST as llm } from "../app/api/workspaces/[id]/llm/route";
import { POST as reset } from "../app/api/workspaces/[id]/reset/route";
import { POST as outbox } from "../app/api/workspaces/[id]/outbox/route";
import { GET as insights } from "../app/api/workspaces/[id]/insights/route";
import { GET as checkout } from "../app/api/workspaces/[id]/checkout/route";
import { POST as order } from "../app/api/workspaces/[id]/checkout/orders/route";
import { GET as receipt, DELETE as cancel } from "../app/api/workspaces/[id]/checkout/orders/[orderId]/route";
import { POST as capture } from "../app/api/workspaces/[id]/checkout/orders/[orderId]/capture/route";

vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/lib/store", () => import("../lib/store"));
vi.mock("@/components/booking/booking-page", () => ({ default: ({ id }: { id: string }) => <main data-booking-id={id}>Book a class</main> }));
vi.mock("@/components/console/expired-demo", () => ({ default: () => <main>This demo has ended</main> }));
import PublicPage from "../app/b/[bookingId]/page";
import PreviewPage from "../app/w/[id]/book/page";

let directory: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "rebook-public-booking-"));
  vi.stubEnv("DATA_DIR", directory);
  limits.reset();
});
afterEach(() => {
  closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.useRealTimers();
});

it("persists unique independent 192-bit public ids, excludes the warm pool, and backfills older workspaces", () => {
  let repository = getRepository();
  const first = repository.createWorkspace(seedStudio());
  const other = repository.createWorkspace(seedStudio());
  const pooled = repository.createWorkspace(seedStudio(), undefined, { pooled: true });
  expect(first.bookingId).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(first.bookingId).not.toBe(first.id); expect(other.bookingId).not.toBe(first.bookingId);
  expect(repository.getWorkspace(first.bookingId)).toBeUndefined();
  expect(repository.getWorkspaceByBookingId(first.id)).toBeUndefined();
  expect(repository.getWorkspaceByBookingId(pooled.bookingId)).toBeUndefined();
  closeRepository();
  const db = new DatabaseSync(join(directory, "rebook.sqlite"));
  db.prepare("UPDATE workspaces SET data = json_remove(data, '$.bookingId') WHERE id = ?").run(other.id);
  db.close();
  repository = getRepository();
  expect(repository.getWorkspaceByBookingId(first.bookingId)?.id).toBe(first.id);
  const migrated = repository.requireWorkspace(other.id).bookingId;
  expect(migrated).toMatch(/^[A-Za-z0-9_-]{32}$/);
  closeRepository(); repository = getRepository();
  expect(repository.requireWorkspace(other.id).bookingId).toBe(migrated);
  const claimed = repository.claimPoolWorkspace()!;
  expect(claimed.bookingId).not.toBe(pooled.bookingId);
  expect(repository.getWorkspaceByBookingId(claimed.bookingId)?.id).toBe(claimed.id);
});

it("rejects the public booking id at every owner route without changing the workspace", async () => {
  const repository = getRepository();
  const workspace = repository.createWorkspace(seedStudio());
  const context = { params: Promise.resolve({ id: workspace.bookingId, planId: randomUUID(), orderId: "ORDER-1" }) };
  const handlers = [ownerRead, plan, details, discard, adjust, approve, interpret, llm, reset, outbox, insights, checkout, order, receipt, cancel, capture];
  for (const handler of handlers) {
    const response = await handler(new Request(`http://localhost/api/workspaces/${workspace.bookingId}`, { method: "POST", body: "{}" }), context);
    expect(response.status, handler.name).toBe(404);
    expect(await response.json()).toMatchObject({ code: "expired" });
  }
  expect(repository.requireWorkspace(workspace.id)).toEqual(workspace);
  expect(repository.listPlans(workspace.id)).toEqual([]); expect(repository.listLedger(workspace.id)).toEqual([]);
  const owner = await ownerRead(new Request("http://localhost"), { params: Promise.resolve({ id: workspace.id }) });
  expect(owner.status).toBe(200); expect(await owner.json()).toMatchObject({ bookingId: workspace.bookingId });
});

it("keeps customer lists, private links, plans and ledger out of the public catalog for a populated workspace", async () => {
  const repository = getRepository();
  const workspace = repository.createWorkspace(seedStudio());
  const plan = repository.createPlan(workspace.id, replan(workspace.state, demoDisruption));
  const booking = workspace.state.bookings[0];
  const link = repository.createCustomerLink({ workspaceId: workspace.id, planId: plan.id, bookingId: booking.id,
    kind: "choice", expiresAt: Date.now() + 60_000, message: { subject: "Private subject", body: "Private body" }, before: workspace.state.sessions[0] });
  repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "capture", amount: booking.amount,
    paypalId: "PRIVATE-CAPTURE", captureId: "PRIVATE-CAPTURE", requestId: "PRIVATE-REQUEST", status: "COMPLETED" });
  const response = await publicCatalog(new Request("http://localhost"), { params: Promise.resolve({ bookingId: workspace.bookingId }) });
  expect(response.status).toBe(200);
  const catalog = await response.json();
  expect(Object.keys(catalog).sort()).toEqual(["sessions", "studio"]);
  const text = JSON.stringify(catalog);
  for (const secret of [workspace.id, plan.id, repository.customerToken(link), "Private subject", "Private body", "PRIVATE-CAPTURE", "PRIVATE-REQUEST",
    ...workspace.state.customers.map((customer) => customer.email)]) expect(text).not.toContain(secret);
});

it("renders /b using only the public id and preserves /w/<id>/book as an owner preview with a public share link", async () => {
  const workspace = getRepository().createWorkspace(seedStudio());
  const publicHtml = renderToStaticMarkup(await PublicPage({ params: Promise.resolve({ bookingId: workspace.bookingId }) }));
  expect(publicHtml).toContain(`data-booking-id="${workspace.bookingId}"`); expect(publicHtml).not.toContain(workspace.id);
  const previewHtml = renderToStaticMarkup(await PreviewPage({ params: Promise.resolve({ id: workspace.id }) }));
  expect(previewHtml).toContain("Owner preview"); expect(previewHtml).toContain(`href="/b/${workspace.bookingId}"`);
  expect(previewHtml).toContain(`data-booking-id="${workspace.bookingId}"`);
  expect(renderToStaticMarkup(await PreviewPage({ params: Promise.resolve({ id: workspace.bookingId }) }))).toContain("This demo has ended");
  expect(renderToStaticMarkup(await PublicPage({ params: Promise.resolve({ bookingId: workspace.id }) }))).toContain("This demo has ended");
});

it("shows the existing ended screen on both booking URLs after expiry", async () => {
  const workspace = getRepository().createWorkspace(seedStudio());
  getRepository().pruneOlderThan(-1);
  expect(renderToStaticMarkup(await PublicPage({ params: Promise.resolve({ bookingId: workspace.bookingId }) }))).toContain("This demo has ended");
  expect(renderToStaticMarkup(await PreviewPage({ params: Promise.resolve({ id: workspace.id }) }))).toContain("This demo has ended");
});
