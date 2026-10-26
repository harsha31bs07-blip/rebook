import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeRepository, getRepository } from "../lib/store";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { DELETE as discard } from "../app/api/workspaces/[id]/plans/[planId]/route";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rebook-discard-"));
  vi.stubEnv("DATA_DIR", directory);
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it("persists proposal discard across reloads without touching schedule, payments or other workspaces", async () => {
  const repository = getRepository();
  const state = seedStudio();
  const workspace = repository.createWorkspace(state);
  const other = repository.createWorkspace(state);
  const plan = repository.createPlan(workspace.id, replan(state, demoDisruption));
  const request = new Request("http://localhost/plan", { method: "DELETE" });
  expect((await discard(request, { params: Promise.resolve({ id: other.id, planId: plan.id }) })).status).toBe(404);
  expect(repository.getPlan(workspace.id, plan.id)).toBeDefined();
  const response = await discard(request, { params: Promise.resolve({ id: workspace.id, planId: plan.id }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ discarded: true });
  closeRepository();
  expect(getRepository().listPlans(workspace.id)).toEqual([]);
  expect(getRepository().requireWorkspace(workspace.id).state).toEqual(state);
  expect(getRepository().latestMoneyEvents(workspace.id)).toEqual([]);
});

it.each(["executing", "executed", "partially_failed"] as const)("refuses to discard a %s recovery", async (status) => {
  const repository = getRepository();
  const state = seedStudio();
  const workspace = repository.createWorkspace(state);
  const plan = repository.createPlan(workspace.id, replan(state, demoDisruption));
  repository.savePlan({ ...plan, status });
  const response = await discard(new Request("http://localhost/plan", { method: "DELETE" }), { params: Promise.resolve({ id: workspace.id, planId: plan.id }) });
  expect(response.status).toBe(409);
  expect(repository.listPlans(workspace.id)).toHaveLength(1);
});
