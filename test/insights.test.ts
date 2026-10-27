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
import { initialReport, REPORT_STATE_VERSION, restoreReportState } from "../lib/insights/report";
import { recoveryDisruptions, recoveryReceipts } from "../lib/insights/ai";
import { buildInsights, type Insights } from "../lib/insights/data";
import { recoveryMetric } from "../lib/insights/metrics";
import { createCustomerLinks } from "../lib/choices/service";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "rebook-insights-")); vi.stubEnv("DATA_DIR", directory); });
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const context = (id: string) => ({ params: Promise.resolve({ id }) });

describe("workspace insights", () => {
  it("attributes completed customer-choice refunds through persisted links without changing planned totals", async () => {
    const repository = getRepository();
    const workspace = repository.createWorkspace(seedStudio());
    const plan = repository.createPlan(workspace.id, replan(workspace.state, demoDisruption));
    plan.status = "executed"; plan.basis = workspace.state; repository.savePlan(plan);
    const state = applyPlan(workspace.state, plan);
    repository.saveState(workspace.id, state);
    createCustomerLinks(plan, workspace.state, state, repository);
    for (const action of plan.bookingActions.filter((item) => item.action === "refund")) {
      repository.appendLedger({ workspaceId: workspace.id, bookingId: action.bookingId, kind: "refund", amount: action.amount,
        requestId: `${plan.id}:${action.bookingId}`, captureId: `cap-${action.bookingId}`, paypalId: `ref-${action.bookingId}`, status: "COMPLETED" });
    }
    const before = buildInsights(state, [plan], repository.listLedger(workspace.id), repository.listCustomerLinks(workspace.id));
    expect(before.disruptions[0]).toMatchObject({ kept: 9, moved: 16, refunded: 6, applied_saved: 25, applied_affected: 31, applied_revenue_kept: 577, completed_refund_amount: 135, no_reply: 25 });
    expect(recoveryMetric(before.disruptions, "saved").value).toBe("81%");
    const link = repository.listCustomerLinks(workspace.id).find((item) => item.bookingId === "booking-0003")!;
    const requestId = `choice:${link.id}`;
    link.reply = { action: "refund", at: new Date().toISOString(), amount: "22.00", requestId };
    repository.saveCustomerLink(link);
    const event = { workspaceId: workspace.id, bookingId: link.bookingId, kind: "refund" as const, amount: "22.00",
      requestId, captureId: "cap-choice", paypalId: "ref-choice" };
    repository.appendLedger({ ...event, status: "REQUESTED" });
    const pending: Insights = await (await GET(new Request("http://localhost"), context(workspace.id))).json();
    expect(pending.disruptions[0]).toMatchObject({ planned_refund_amount: 135, completed_refund_amount: 135, pending_refund_amount: 22, applied_saved: 24, applied_revenue_kept: 555, refunded: 6, pending: 1, no_reply: 24 });
    repository.appendLedger({ ...event, status: "COMPLETED" });
    // Persisted links must survive reopening the repository, just like a server restart.
    closeRepository();
    const data: Insights = await (await GET(new Request("http://localhost"), context(workspace.id))).json();
    expect(data.disruptions[0]).toMatchObject({ planned_refund_amount: 135, completed_refund_amount: 157, pending_refund_amount: 0, kept: 8, moved: 16, refunded: 7, applied_saved: 24, applied_revenue_kept: 555, pending: 0, no_reply: 24 });
    expect(recoveryMetric(data.disruptions, "saved").value).toBe("77%");
    expect(data.money_events.find((row) => row.paypal_id === "ref-choice")).toMatchObject({
      plan_id: plan.id, booking_action_id: `${plan.id}:${link.bookingId}`, reason: "Customer chose a refund", issued_refund: 22,
    });
    expect(recoveryDisruptions(data, plan.id)[0]).toMatchObject({ plannedRefundsUSD: 135, completedRefundsUSD: 157, pendingRefundsUSD: 0 });
    expect(recoveryReceipts(data, plan.id, "COMPLETED")).toHaveLength(7);
    expect(recoveryReceipts(data, plan.id).find((row) => row.reason === "Customer chose a refund")?.disruption).not.toBe("Disruption unavailable");
    expect(getRepository().listLedger(workspace.id).filter((row) => row.paypalId === "ref-choice").every((row) => row.requestId === requestId)).toBe(true);
    const source = buildStudioData(data).sources.find((source) => source.id === "disruptions")!;
    if (!("fields" in source)) throw new Error("Expected explicit disruption fields");
    expect(source.fields!.find((field) => field.id === "completed_refund_amount")?.format).toBe("currencyFormat");
  });

  it("separates planned, pending, completed, simulated and failed refund amounts using latest events", () => {
    const repository = getRepository();
    const workspace = repository.createWorkspace(seedStudio());
    const plan = repository.createPlan(workspace.id, replan(workspace.state, demoDisruption));
    plan.status = "partially_failed";
    const actions = plan.bookingActions.filter((action) => action.action === "refund");
    expect(actions.length).toBeGreaterThanOrEqual(5);
    const statuses = ["COMPLETED", "PENDING", "REQUESTED", "SIMULATED", "FAILED"];
    for (const [index, action] of actions.slice(0, 5).entries()) {
      const base = { workspaceId: workspace.id, bookingId: action.bookingId, kind: "refund" as const, amount: action.amount,
        paypalId: `refund-${index}`, captureId: `capture-${index}`, requestId: `${plan.id}:${action.bookingId}` };
      repository.appendLedger({ ...base, status: "REQUESTED" });
      repository.appendLedger({ ...base, status: statuses[index] });
    }
    const insights = buildInsights(workspace.state, [plan], repository.listLedger(workspace.id));
    expect(insights.disruptions[0]).toMatchObject({ planned_refund_amount: Number(plan.totals.refundAmount),
      completed_refund_amount: Number(actions[0].amount), pending_refund_amount: Number(actions[1].amount) + Number(actions[2].amount),
      simulated_refund_amount: Number(actions[3].amount), failed_refund_amount: Number(actions[4].amount) });
    expect(insights.money_events.filter((event) => event.status === "REQUESTED")).toHaveLength(1);
  });
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
    expect(data.disruptions[0]).toMatchObject({ id: plan.id, status: "partially_failed", completed_refund_amount: Number(action.amount), pending_refund_amount: 0 });
    expect(data.money_events).toHaveLength(1);
    expect(data.money_events[0].booking_action_id).toBe(`${plan.id}:${action.bookingId}`);
    const receipt = recoveryReceipts(data)[0];
    expect(receipt.class).toContain(" at ");
    expect(receipt.customer).not.toBe(action.bookingId);
    expect(JSON.stringify(receipt)).not.toContain(plan.id);
    expect(JSON.stringify(receipt)).not.toContain(action.bookingId);
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
    expect(data.disruptions[0].covers).not.toMatch(/session-\d+/);
    expect(JSON.stringify(recoveryDisruptions(data))).not.toContain(data.disruptions[0].id);
  });

  it("rejects invalid, missing and preparing workspaces", async () => {
    expect((await GET(new Request("http://localhost"), context("bad"))).status).toBe(404);
    expect((await GET(new Request("http://localhost"), context("missing123"))).status).toBe(404);
    const workspace = getRepository().createWorkspace(seedStudio(), undefined, { preparing: true });
    expect((await GET(new Request("http://localhost"), context(workspace.id))).status).toBe(409);
  });
});


describe("initial Studio report", () => {
  it("silently discards old, unversioned and malformed saved reports", () => {
    for (const saved of [null, "broken", JSON.stringify(initialReport), JSON.stringify({ version: REPORT_STATE_VERSION - 1, state: initialReport })]) {
      expect(restoreReportState(saved)).toBe(initialReport);
    }
    const state = { ...initialReport, selectedPageId: "disruptions" };
    expect(restoreReportState(JSON.stringify({ version: REPORT_STATE_VERSION, state }))).toEqual(state);
  });

  it("uses valid mapped fields, supported single-field sorts and unambiguous relationships", async () => {
    const workspace = getRepository().createWorkspace(seedStudio());
    const data: Insights = await (await GET(new Request("http://localhost"), context(workspace.id))).json();
    const model = buildStudioData(data);
    const fields = new Set(model.sources.flatMap((source) => ("fields" in source ? source.fields ?? [] : []).map((field) => `${source.id}.${field.id}`)));
    for (const expression of model.expressions ?? []) fields.add(expression.id);
    // There is no exported report validator. Check the widget constraints enforced by Studio's hydrator.
    expect(initialReport.pages.some((page) => page.id === initialReport.selectedPageId)).toBe(true);
    for (const page of initialReport.pages) for (const [id, widget] of Object.entries(page.widgets ?? {})) {
      if (!widget) continue;
      expect(page.widgetLayout?.[id]).toBeDefined();
      expect(("sort" in widget ? widget.sort?.length : 0) ?? 0).toBeLessThanOrEqual(1);
      for (const mapping of Object.values(widget.dataMapping)) for (const field of mapping ?? []) expect(fields.has(field.id), field.id).toBe(true);
      for (const sort of ("sort" in widget ? widget.sort : []) ?? []) expect(fields.has(sort.field.id), sort.field.id).toBe(true);
      if (widget.type === "grid") expect(widget.dataMapping.cols.every((field) => !/\.(id|.*_id)$/.test(field.id))).toBe(true);
    }
    // An undirected forest has exactly one path between any connected pair, including the receipt/action queries.
    const parents = new Map(model.sources.map((source) => [source.id, source.id]));
    const root = (id: string): string => parents.get(id) === id ? id : root(parents.get(id)!);
    for (const relation of insightRelationships) {
      if (!("tableId" in relation.target)) continue;
      const from = root(relation.source.tableId), to = root(relation.target.tableId);
      expect(from, `Cycle at ${relation.id}`).not.toBe(to);
      parents.set(from, to);
    }
    expect(new Set([...parents.keys()].map(root)).size).toBe(1);
    const actions = initialReport.pages[1].widgets!.actions!;
    if (actions.type !== "grid") throw new Error("Expected booking actions grid");
    const sort = actions.sort![0];
    const values = ["keep", "refund", "move"].sort((a, b) => sort.direction === "desc" ? b.localeCompare(a) : a.localeCompare(b));
    expect(values).toEqual(["refund", "move", "keep"]);
    for (const id of ["revenue_booked_kpi", "revenue_kept_kpi", "refunds_issued_kpi"]) {
      expect(model.expressions!.find((field) => field.id === id)?.formatOptions).toEqual({ format: "$#,##0" });
    }
    const sessions = model.sources.find((source) => source.id === "sessions")!;
    if (!("fields" in sessions)) throw new Error("Expected explicit session fields");
    expect(sessions.fields!.find((field) => field.id === "price")?.formatOptions).toEqual({ format: "$#,##0.00" });
  });
});
