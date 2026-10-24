import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { WebMcpTool } from "../lib/webmcp/bridge";
import type { PlanDetails, PublicPlan, WorkspaceResponse } from "../lib/client/api";
import { demoDisruption, seedStudio } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";

// Follow the checkout suite's lightweight hook harness: no DOM/test-renderer dependency.
const harness = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], tools: [] as WebMcpTool[], workspace: undefined as WorkspaceResponse | undefined,
  api: { interpret: vi.fn(), plan: vi.fn(), details: vi.fn(), approve: vi.fn(), adjust: vi.fn() }, refresh: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => harness.slots[harness.cursor++] ??= { current: initial },
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = typeof initial === "function" ? initial() : initial;
    return [harness.slots[index], (value: unknown) => { harness.slots[index] = typeof value === "function" ? value(harness.slots[index]) : value; }];
  },
  useEffect: () => {},
}));
vi.mock("next/dynamic", () => ({ default: () => "dynamic-view" }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("next/script", () => ({ default: "script" }));
vi.mock("@/lib/client/api", () => ({ api: harness.api, ApiError: class extends Error {} }));
vi.mock("@/lib/client/scheduler-mapping", () => import("../lib/client/scheduler-mapping"));
vi.mock("@/lib/client/paypal-v6", () => import("../lib/client/paypal-v6"));
vi.mock("../lib/webmcp/use-webmcp", () => ({ useWebMcp: (tools: WebMcpTool[] | (() => WebMcpTool[])) => { harness.tools = typeof tools === "function" ? tools() : tools; } }));
vi.mock("../components/console/use-workspace", () => ({ useWorkspace: () => ({ workspace: harness.workspace, refresh: harness.refresh }) }));
vi.mock("../components/console/plan-panel", () => ({ default: "plan-panel" }));
vi.mock("../components/console/console-header", () => ({ default: "console-header" }));
vi.mock("../components/console/messages-drawer", () => ({ default: "messages-drawer" }));
vi.mock("../components/console/expired-demo", () => ({ default: "expired-demo" }));
import OwnerConsole from "../components/console/owner-console";
import DisruptionPanel from "../components/console/disruption-panel";
import BookingPage, { Payments } from "../components/booking/booking-page";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function find(tree: ReactNode, predicate: (element: Element) => boolean) {
  const element = elements(tree).find(predicate);
  if (!element) throw new Error("Expected element missing");
  return element;
}
const context = { signal: new AbortController().signal };
const call = (name: string, args: Record<string, unknown> = {}) => harness.tools.find((tool) => tool.name === name)!.execute(args, context);
const renderOwner = () => { harness.cursor = 0; return OwnerConsole({ id: "workspace" }); };
let details: PlanDetails;
beforeEach(() => {
  vi.clearAllMocks(); harness.cursor = 0; harness.slots = []; harness.tools = [];
  const state = seedStudio();
  const plan: PublicPlan = { ...replan(state, demoDisruption), id: "plan-1", workspaceId: "workspace", createdAt: new Date().toISOString(), status: "proposed", results: [] };
  details = { plan, sessions: state.sessions, explanation: { headline: "Recovery ready", bullets: [], source: "template" }, messages: [] };
  harness.workspace = { id: "workspace", createdAt: plan.createdAt, updatedAt: plan.createdAt, status: "ready", state, plans: [plan], ledger: [], ledgerSummary: {}, progress: { done: 1, total: 1 } };
  harness.api.interpret.mockResolvedValue({ disruption: demoDisruption, confidence: 1, source: "rules", notes: [] });
  harness.api.plan.mockResolvedValue(plan); harness.api.details.mockResolvedValue(details); harness.refresh.mockResolvedValue(undefined);
});

describe("WebMCP page handlers and human payment boundary", () => {
  it("prepares the exact same timeline preview through tools and the owner UI", async () => {
    let tree = renderOwner();
    const ui = find(tree, (element) => element.type === DisruptionPanel);
    await (ui.props.onInterpret as (text: string) => Promise<unknown>)("Maya is out Monday");
    tree = renderOwner();
    await (find(tree, (element) => element.type === DisruptionPanel).props.onPlan as () => Promise<void>)();
    tree = renderOwner();
    const uiPreview = find(tree, (element) => element.type === "dynamic-view" && Boolean(element.props.plan));
    expect(uiPreview.props.plan).toEqual(details.plan);
    const result = await call("report_disruption", { text: "Maya is out Monday" });
    tree = renderOwner();
    const toolPreview = find(tree, (element) => element.type === "dynamic-view" && Boolean(element.props.plan));
    expect(toolPreview.props).toMatchObject({ plan: uiPreview.props.plan, state: uiPreview.props.state, zoom: "week" });
    expect(result).toMatchObject({ planId: "plan-1", ...details.plan.totals, currency: "USD" });
    expect(await call("get_plan_summary")).toMatchObject({ planId: "plan-1", ...details.plan.totals });
    expect(harness.api.interpret).toHaveBeenCalledTimes(2);
    expect(harness.api.plan).toHaveBeenCalledTimes(2);
    expect(harness.api.approve).not.toHaveBeenCalled();
  });

  it("request_approval displays a proposed plan and banner without calling the approve route", async () => {
    renderOwner();
    expect(await call("request_approval", { planId: "plan-1" })).toMatchObject({ approval: "awaiting_owner_click" });
    const tree = renderOwner();
    expect(find(tree, (element) => element.type === "plan-panel").props).toMatchObject({ approvalRequested: true, plan: details.plan });
    expect(harness.api.approve).not.toHaveBeenCalled();
    expect(harness.api.plan).not.toHaveBeenCalled();
    expect(harness.api.details).toHaveBeenCalledWith("workspace", "plan-1", context.signal);
    details.plan.status = "executed";
    await expect(call("request_approval", { planId: "plan-1" })).rejects.toThrow("Only a proposed plan");
    expect(harness.api.approve).not.toHaveBeenCalled();
  });

  it("leaves execution on the owner's explicit approval button handler", async () => {
    harness.api.approve.mockResolvedValue({ plan: { ...details.plan, status: "executed" }, results: [] });
    renderOwner();
    await call("request_approval", { planId: "plan-1" });
    const tree = renderOwner();
    expect(harness.api.approve).not.toHaveBeenCalled();
    (find(tree, (element) => element.type === "plan-panel").props.onApprove as () => void)();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(harness.api.approve).toHaveBeenCalledExactlyOnceWith("workspace", "plan-1", 1);
  });

  it("keeps the adjusted version through an older workspace poll and approves that version", async () => {
    renderOwner(); await call("request_approval", { planId: "plan-1" });
    const input = { sessionId: details.plan.sessionChanges[0].sessionId, start: "2026-11-10T14:00:00Z" };
    const adjusted = { ...details.plan, version: 2, totals: { ...details.plan.totals, moved: 7 } };
    harness.api.adjust.mockResolvedValue(adjusted);
    const timeline = find(renderOwner(), (element) => element.type === "dynamic-view" && Boolean(element.props.plan));
    await (timeline.props.onAdjust as (input: object) => Promise<void>)(input);
    expect(harness.api.adjust).toHaveBeenCalledExactlyOnceWith("workspace", "plan-1", input, 1);
    const tree = renderOwner();
    expect(find(tree, (element) => element.type === "plan-panel").props.plan).toEqual(adjusted);
    harness.api.approve.mockResolvedValue({ plan: { ...adjusted, status: "executed" }, results: [] });
    (find(tree, (element) => element.type === "plan-panel").props.onApprove as () => void)();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(harness.api.approve).toHaveBeenCalledExactlyOnceWith("workspace", "plan-1", 2);
  });

  it("accepts a saved adjustment when its subsequent workspace refresh fails", async () => {
    renderOwner(); await call("request_approval", { planId: "plan-1" });
    harness.api.adjust.mockResolvedValue({ ...details.plan, version: 2 });
    harness.refresh.mockRejectedValueOnce(new Error("Offline"));
    const timeline = find(renderOwner(), (element) => element.type === "dynamic-view" && Boolean(element.props.plan));
    await expect((timeline.props.onAdjust as (input: object) => Promise<void>)({ sessionId: "session-001", start: "2026-11-10T14:00:00Z" })).resolves.toBeUndefined();
    expect(find(renderOwner(), (element) => element.props.role === "alert").props.children).toContain("Adjustment saved");
  });

  it("withholds mutating tools while busy and rejects overlapping preparation calls", async () => {
    let resolve!: (value: unknown) => void;
    harness.api.interpret.mockReturnValue(new Promise((done) => { resolve = done; }));
    renderOwner();
    const pending = call("report_disruption", { text: "Maya is out Monday" });
    await expect(call("report_disruption", { text: "Maya is out Monday" })).rejects.toThrow("in progress");
    renderOwner();
    expect(harness.tools.map((tool) => tool.name)).toEqual(["get_week_schedule", "get_plan_summary"]);
    resolve({ disruption: demoDisruption }); await pending;
    expect(harness.api.approve).not.toHaveBeenCalled();
  });

  it("surfaces interpretation errors without returning a successful plan", async () => {
    harness.api.interpret.mockRejectedValue(new Error("Please specify the day"));
    renderOwner();
    await expect(call("report_disruption", { text: "Maya is out" })).rejects.toThrow("specify the day");
    expect(harness.api.plan).not.toHaveBeenCalled();
    expect(find(renderOwner(), (element) => element.props.role === "alert").props.children).toBe("Please specify the day");
  });

  it("uses the visible declarative form's text and responds with the shared preview result", async () => {
    const onInterpret = vi.fn(async () => "interpreted"), onReport = vi.fn(async () => ({ planId: "plan-1" }));
    const tree = DisruptionPanel({ state: harness.workspace!.state, text: "old controlled value", setText: vi.fn(), onInterpret, onReport, onEdit: vi.fn(), onPlan: vi.fn(), busy: false });
    const form = find(tree, (element) => element.type === "form");
    expect(form.props).toMatchObject({ toolname: "preview_disruption", toolautosubmit: "" });
    expect(find(tree, (element) => element.type === "textarea").props.name).toBe("text");
    const preventDefault = vi.fn(), respondWith = vi.fn();
    const event = { preventDefault, currentTarget: { elements: { namedItem: () => ({ value: "agent-filled text" }) } }, nativeEvent: { agentInvoked: true, respondWith } };
    (form.props.onSubmit as (event: unknown) => void)(event);
    expect(preventDefault).toHaveBeenCalled();
    expect(onReport).toHaveBeenCalledWith("agent-filled text");
    expect(await respondWith.mock.calls[0][0]).toEqual({ planId: "plan-1" });
    expect(onInterpret).not.toHaveBeenCalled();
  });

  it("selects and prefills the same customer checkout card as clicking a class, without payment requests", async () => {
    harness.slots = []; harness.cursor = 0;
    const session = { ...harness.workspace!.state.sessions[0], seatsLeft: 3, instructor: "Maya", room: "Main" };
    // Catalog is the booking page's first state slot, ordinarily populated by its GET effect.
    harness.slots[0] = { studio: harness.workspace!.state.studio, sessions: [session] };
    const renderBooking = () => { harness.cursor = 0; return BookingPage({ id: "workspace", clientId: "client", sandbox: true }); };
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    try {
      let tree = renderBooking();
      (find(tree, (element) => element.type === "button" && String(element.props.className).includes("bookable-class")).props.onClick as () => void)();
      tree = renderBooking();
      expect(find(tree, (element) => element.type === Payments).props.session).toEqual(session);
      await call("start_booking", { sessionId: session.id, name: "Alex Agent", email: "alex@example.com" });
      tree = renderBooking();
      const checkout = find(tree, (element) => element.type === Payments);
      expect(checkout.props).toMatchObject({ session, customer: { name: "Alex Agent", email: "alex@example.com" } });
      (checkout.props.onLockChange as (locked: boolean) => void)(true);
      renderBooking();
      expect(harness.tools.map((tool) => tool.name)).toEqual(["list_classes"]);
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
