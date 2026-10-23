import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/workspaces/[id]/insights/route";
import { closeRepository, getRepository } from "../lib/store";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { applyPlan } from "../lib/solver/validate";
import { buildStudioData, insightRelationships } from "../lib/insights/studio-data";
import type { Insights } from "../lib/insights/data";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "rebook-insights-")); vi.stubEnv("DATA_DIR", directory); });
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const context = (id: string) => ({ params: Promise.resolve({ id }) });

describe("workspace insights", () => {
  it("returns scoped flat tables with joinable cancelled sessions and latest refund status", async () => {
    const repository = getRepository();
    const state = seedStudio();
    const workspace = repository.createWorkspace(state);
    const other = repository.createWorkspace(seedStudio());
    repository.createPlan(other.id, replan(other.state, demoDisruption));
    const plan = repository.createPlan(workspace.id, replan(state, { kind: "closure", from: state.studio.weekStart, to: "2026-11-16T05:00:00Z" }, { horizonDays: 0 }));
    plan.status = "executed"; plan.basis = state; repository.savePlan(plan);
    repository.saveState(workspace.id, applyPlan(state, plan));
    const action = plan.bookingActions.find((action) => action.action === "refund")!;
    const base = { workspaceId: workspace.id, bookingId: action.bookingId, kind: "refund" as const,
      amount: action.amount, requestId: `${plan.id}:${action.bookingId}`, captureId: "CAP-1", paypalId: "REF-1" };
    repository.appendLedger({ ...base, status: "REQUESTED" });
    repository.appendLedger({ ...base, status: "PENDING" });
    repository.appendLedger({ ...base, status: "COMPLETED" });
    const response = await GET(new Request("http://localhost"), context(workspace.id));
    expect(response.status).toBe(200);
    const data: Insights = await response.json();
    expect(data.disruptions).toHaveLength(1);
    expect(data.disruptions[0]).toMatchObject({ id: plan.id, status: "executed" });
    expect(data.money_events).toHaveLength(1);
    expect(data.money_events[0]).toMatchObject({ paypal_id: "REF-1", status: "COMPLETED", plan_id: plan.id, issued_refund: Number(action.amount) });
    expect(data.sessions.some((row) => row.status === "cancelled")).toBe(true);
    const first = data.sessions.find((session) => session.id === state.sessions[0].id)!;
    expect(first.local_day).toBe(state.sessions[0].start.slice(0, 10));
    expect(first.local_start).toBe("07:00");
    expect(JSON.stringify(data)).not.toContain("@example");
    const model = buildStudioData(data);
    expect(model.sources).toHaveLength(8);
    for (const relationship of insightRelationships) {
      if (!("tableId" in relationship.target)) continue;
      const targetRef = relationship.target;
      const source = model.sources.find((table) => table.id === relationship.source.tableId)!;
      const target = model.sources.find((table) => table.id === targetRef.tableId)!;
      if (!("data" in source) || !("data" in target)) throw new Error("Expected sync tables");
      expect(source.fields?.some((field) => field.id === relationship.source.fieldId)).toBe(true);
      expect(target.fields?.some((field) => field.id === targetRef.fieldId)).toBe(true);
      const ids = new Set(target.data.map((row) => row[targetRef.fieldId]));
      for (const row of source.data) {
        const foreignKey = row[relationship.source.fieldId];
        if (foreignKey != null) expect(ids.has(foreignKey), `${relationship.id}: ${foreignKey}`).toBe(true);
      }
    }
  });

  it("keeps empty tables queryable and proposals out of applied recovery KPIs", async () => {
    const repository = getRepository();
    const workspace = repository.createWorkspace(seedStudio());
    const empty: Insights = await (await GET(new Request("http://localhost"), context(workspace.id))).json();
    expect(empty.disruptions).toEqual([]); expect(empty.money_events).toEqual([]);
    const events = buildStudioData(empty).sources.find((table) => table.id === "money_events")!;
    expect("data" in events && events.fields!.length).toBeGreaterThan(5);
    repository.createPlan(workspace.id, replan(workspace.state, demoDisruption));
    const data: Insights = await (await GET(new Request("http://localhost"), context(workspace.id))).json();
    expect(data.disruptions[0]).toMatchObject({ applied_affected: 0, applied_saved: 0, applied_revenue_kept: 0 });
    expect(data.disruptions[0].covers).toContain("covered Maya");
  });

  it("rejects invalid, missing and preparing workspaces", async () => {
    expect((await GET(new Request("http://localhost"), context("bad"))).status).toBe(400);
    expect((await GET(new Request("http://localhost"), context("missing123"))).status).toBe(404);
    const workspace = getRepository().createWorkspace(seedStudio(), undefined, { preparing: true });
    expect((await GET(new Request("http://localhost"), context(workspace.id))).status).toBe(409);
  });
});
