import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import type { PlanDetails, WorkspaceResponse } from "../lib/client/api";
import { demoDisruption, seedStudio } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";

const harness = vi.hoisted(() => ({
  cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: [] as (() => void)[],
  api: { create: vi.fn(), details: vi.fn(), workspace: vi.fn() }, push: vi.fn(),
  ApiError: class extends Error { constructor(public status: number, message: string, public code?: string, public retryAfter?: number) { super(message); } },
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (value: unknown) => harness.slots[harness.cursor++] ??= { current: value },
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = typeof initial === "function" ? initial() : initial;
    return [harness.slots[index], (value: unknown) => { harness.slots[index] = typeof value === "function" ? value(harness.slots[index]) : value; }];
  },
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    const index = harness.cursor++;
    const previous = harness.slots[index] as unknown[] | undefined;
    if (!previous || deps.some((value, i) => value !== previous[i])) {
      harness.slots[index] = deps;
      harness.effects.push(() => { harness.cleanups[index]?.(); const cleanup = effect(); harness.cleanups[index] = cleanup ?? (() => {}); });
    }
  },
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: harness.push }) }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("next/dynamic", () => ({ default: () => "booking-grid" }));
vi.mock("@/lib/client/api", () => ({ api: harness.api, ApiError: harness.ApiError }));
vi.mock("../lib/client/api", () => ({ api: harness.api, ApiError: harness.ApiError }));
vi.mock("@/lib/client/scheduler-mapping", () => import("../lib/client/scheduler-mapping"));
vi.mock("@/lib/domain/time", () => import("../lib/domain/time"));
import OpenDemoButton from "../components/console/open-demo-button";
import JudgeHint, { JUDGE_HINT_KEY } from "../components/console/judge-hint";
import { usePlanPreview } from "../components/console/use-plan-preview";
import { useWorkspace } from "../components/console/use-workspace";
import DisruptionPanel from "../components/console/disruption-panel";
import PlanPanel, { RefundResults } from "../components/console/plan-panel";
import BuiltWithPage from "../app/built-with/page";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
const button = (tree: ReactNode) => elements(tree).find((element) => element.type === "button")!;
function render<T>(component: () => T): T { harness.cursor = 0; const result = component(); harness.effects.splice(0).forEach((effect) => effect()); return result; }
async function settle() { for (let index = 0; index < 10; index++) await Promise.resolve(); }
let workspace: WorkspaceResponse;
let details: PlanDetails;
let storage: Map<string, string>;
beforeEach(() => {
  harness.slots = []; harness.effects = []; harness.cleanups = []; harness.cursor = 0; vi.clearAllMocks();
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  const state = seedStudio();
  const plan = { ...replan(state, demoDisruption), id: "proposal", workspaceId: "workspace1", status: "proposed" as const, createdAt: "2026-10-26T00:00:00Z", results: [] };
  workspace = { id: "workspace1", createdAt: plan.createdAt, updatedAt: plan.createdAt, status: "ready", state, plans: [plan], ledger: [], ledgerSummary: {}, progress: { done: 1, total: 1 } };
  details = { plan, sessions: state.sessions, explanation: { headline: "Recovery ready", bullets: [], source: "template" }, messages: [] };
  harness.api.details.mockResolvedValue(details);
});
afterEach(() => { harness.cleanups.forEach((cleanup) => cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("cold start feedback", () => {
  it("shows the 429 reason and Retry-After countdown, ignores clicks and retries exactly once", async () => {
    vi.useFakeTimers();
    harness.api.create.mockRejectedValueOnce(new harness.ApiError(429, "Busy preparing another studio", undefined, 8))
      .mockRejectedValueOnce(new harness.ApiError(429, "Busy preparing another studio", undefined, 8));
    const View = () => OpenDemoButton({});
    const click = button(render(View)).props.onClick as () => void;
    click(); await settle();
    expect(button(render(View)).props.children).toContain("Busy preparing another studio, retrying in 8 s");
    for (let i = 0; i < 10; i++) click();
    expect(harness.api.create).toHaveBeenCalledTimes(1);
    expect(button(render(View)).props.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(7000);
    expect(button(render(View)).props.children).toContain("Busy preparing another studio, retrying in 1 s");
    await vi.advanceTimersByTimeAsync(1000); await settle();
    expect(harness.api.create).toHaveBeenCalledTimes(2);
    expect(renderToStaticMarkup(render(View))).toContain("Busy preparing another studio. Try again in 8 s.");
    expect(button(render(View)).props.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.api.create).toHaveBeenCalledTimes(2);
  });
  it("opens the demo when the automatic busy retry succeeds and cancels retries on unmount", async () => {
    vi.useFakeTimers();
    harness.api.create.mockRejectedValueOnce(new harness.ApiError(429, "Busy preparing another studio", undefined, 2))
      .mockResolvedValueOnce({ id: "workspace1" });
    const View = () => OpenDemoButton({});
    (button(render(View)).props.onClick as () => void)(); await settle();
    await vi.advanceTimersByTimeAsync(2000); await settle();
    expect(harness.push).toHaveBeenCalledExactlyOnceWith("/w/workspace1");
    harness.cleanups.forEach((cleanup) => cleanup?.()); harness.cleanups = []; harness.slots = [];
    harness.api.create.mockRejectedValueOnce(new harness.ApiError(429, "Busy preparing another studio", undefined, 2));
    (button(render(View)).props.onClick as () => void)(); await settle();
    harness.cleanups.forEach((cleanup) => cleanup?.());
    await vi.advanceTimersByTimeAsync(5000);
    expect(harness.api.create).toHaveBeenCalledTimes(3);
  });
  it("shows immediate, waking and preparing states without duplicate workspace creation", async () => {
    vi.useFakeTimers();
    let resolve!: (value: { id: string }) => void;
    harness.api.create.mockReturnValue(new Promise((done) => { resolve = done; }));
    const View = () => OpenDemoButton({});
    let tree = render(View);
    const click = button(tree).props.onClick as () => void;
    click(); click();
    tree = render(View);
    expect(button(tree).props.children).toContain("Opening your studio...");
    expect(button(tree).props.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(2999);
    expect(button(render(View)).props.children).toContain("Opening your studio...");
    await vi.advanceTimersByTimeAsync(1);
    expect(button(render(View)).props.children).toContain("Waking the studio up (free hosting, up to a minute)...");
    resolve({ id: "workspace1" }); await settle();
    expect(button(render(View)).props.children).toContain("Preparing your studio...");
    expect(harness.push).toHaveBeenCalledExactlyOnceWith("/w/workspace1");
    expect(harness.api.create).toHaveBeenCalledTimes(1);
  });
  it("cancels the waking timer for fast responses and lets failed requests retry", async () => {
    vi.useFakeTimers();
    harness.api.create.mockRejectedValueOnce(new Error("internal stack"));
    const View = () => OpenDemoButton({ destination: "booking" });
    (button(render(View)).props.onClick as () => void)(); await settle();
    expect(button(render(View)).props.disabled).toBe(false);
    expect(button(render(View)).props.children).toContain("Retry opening the demo");
    harness.api.create.mockResolvedValueOnce({ id: "workspace1" });
    (button(render(View)).props.onClick as () => void)(); await settle();
    await vi.advanceTimersByTimeAsync(4000);
    expect(button(render(View)).props.children).toContain("Preparing your studio...");
    expect(harness.push).toHaveBeenCalledWith("/w/workspace1/book");
  });
  it("shows waking feedback on a slow first workspace GET and preparation after it responds", async () => {
    vi.useFakeTimers();
    let resolve!: (value: WorkspaceResponse) => void;
    harness.api.workspace.mockReturnValue(new Promise((done) => { resolve = done; }));
    const View = () => useWorkspace("workspace1", false);
    expect(render(View).startupMessage).toBe("Opening your studio...");
    await vi.advanceTimersByTimeAsync(3000);
    expect(render(View).startupMessage).toContain("Waking the studio up");
    resolve({ ...workspace, status: "preparing" }); await settle();
    expect(render(View).startupMessage).toBe("Preparing your studio...");
  });
});

describe("saved recovery preview", () => {
  it("restores the latest proposed plan on reload, including its original sessions", async () => {
    workspace.plans = [{ ...details.plan, id: "executed", status: "executed" }, { ...details.plan, id: "older" }, details.plan];
    const View = () => usePlanPreview("workspace1", workspace);
    expect(render(View).details).toBeUndefined(); await settle();
    expect(render(View)).toMatchObject({ details, basis: { sessions: details.sessions } });
    expect(harness.api.details).toHaveBeenCalledWith("workspace1", "proposal", expect.any(AbortSignal));
    // A reload starts new hook state and fetches the same persisted proposal.
    harness.cleanups.forEach((cleanup) => cleanup?.()); harness.cleanups = []; harness.slots = [];
    render(View); await settle();
    expect(render(View).details?.plan.id).toBe("proposal");
    expect(harness.api.details).toHaveBeenCalledTimes(2);
  });
  it.each(["executing", "executed", "partially_failed"] as const)("restores the latest %s recovery with refund rows and resume/check controls", async (status) => {
    const plan = { ...details.plan, id: "latest", status, results: [{ bookingId: workspace.state.bookings[0].id, status: "PENDING", paypalId: "saved-refund" }] };
    workspace.plans = [{ ...details.plan, id: "older" }, plan];
    harness.api.details.mockResolvedValue({ ...details, plan });
    const View = () => usePlanPreview("workspace1", workspace);
    render(View); await settle();
    const restored = render(View);
    expect(restored.details?.plan).toEqual(plan);
    expect(harness.api.details).toHaveBeenCalledWith("workspace1", "latest", expect.any(AbortSignal));
    const panel = PlanPanel({ details: restored.details!, plan, state: restored.basis!, results: plan.results, busy: false,
      onApprove: vi.fn(), onDiscard: vi.fn(), onMessages: vi.fn() });
    const expected = status === "executing" ? "Resume refund processing" : status === "executed" ? "Check refund status" : "Retry";
    expect(elements(panel).find((element) => element.type === "button" && element.props.children === expected)).toBeDefined();
    expect(renderToStaticMarkup(RefundResults({ state: workspace.state, results: restored.details!.plan.results }))).toContain("saved-refund");
  });
  it("ignores a stale restore after owner input", async () => {
    const View = () => usePlanPreview("workspace1", workspace);
    let resolve!: (value: PlanDetails) => void;
    harness.api.details.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(View).setDetails(undefined);
    resolve(details); await settle();
    expect(render(View).details).toBeUndefined();
  });
  it("offers a retry after restoration fails", async () => {
    harness.api.details.mockRejectedValueOnce(new Error("unavailable"));
    const View = () => usePlanPreview("workspace1", workspace);
    render(View); await settle();
    expect(render(View).restoreError).toContain("Retry");
    await render(View).restore();
    expect(render(View).details?.plan.id).toBe("proposal");
    expect(render(View).restoreError).toBe("");
  });
});

it("remembers quick-tour dismissal after reload and routes steps to the requested control", () => {
  const onStep = vi.fn();
  const View = () => JudgeHint({ id: "workspace1", ready: true, preview: false, hasPlan: false, onStep });
  const tree = render(View);
  const controls = elements(tree).filter((element) => element.type === "button");
  for (const control of controls.slice(1, 3)) (control.props.onClick as () => void)();
  expect(controls[3].props.disabled).toBe(true);
  const preview = render(() => JudgeHint({ id: "workspace1", ready: true, preview: true, hasPlan: true, onStep }));
  const previewControls = elements(preview).filter((element) => element.type === "button");
  expect(previewControls[1].props.disabled).toBe(true);
  for (const control of previewControls.slice(3)) (control.props.onClick as () => void)();
  expect(onStep.mock.calls.map(([step]) => step)).toEqual(["example", "plan", "move", "approve", "messages"]);
  (controls[0].props.onClick as () => void)();
  expect(render(View)).toBeNull();
  expect(storage.get(JUDGE_HINT_KEY)).toBe("1");
  harness.slots = [];
  expect(render(View)).toBeNull();
});

it("explains rules fallback and hides upstream refund diagnostics behind a Retry banner", () => {
  const interpreted = render(() => DisruptionPanel({ state: workspace.state, text: "Maya is out Monday", setText: vi.fn(), busy: false,
    interpretation: { disruption: demoDisruption, confidence: 0.85, source: "rules", aiBusy: true, notes: [] }, onInterpret: vi.fn(), onReport: vi.fn(), onEdit: vi.fn(), onPlan: vi.fn() }));
  const pill = elements(interpreted).find((element) => element.props.title);
  expect(pill?.props).toMatchObject({ children: "Rules (AI busy)", tabIndex: 0, title: expect.stringContaining("local rules parser") });
  const results = [{ bookingId: workspace.state.bookings[0].id, status: "REQUESTED", error: "Error: stack trace secret" }];
  const html = renderToStaticMarkup(RefundResults({ state: workspace.state, results }));
  expect(html).not.toContain("stack trace secret");
  expect(html).toContain("hasn&#x27;t confirmed");
  const panel = PlanPanel({ state: workspace.state, details, plan: { ...details.plan, status: "partially_failed" }, results, busy: false,
    onApprove: vi.fn(), onDiscard: vi.fn(), onMessages: vi.fn() });
  expect(elements(panel).find((element) => element.props.role === "alert")).toBeDefined();
  expect(elements(panel).find((element) => element.type === "button" && element.props.children === "Retry")).toBeDefined();
});

it("renders every built-with section with feature tables and live-flow links", async () => {
  const html = renderToStaticMarkup(await BuiltWithPage({ searchParams: Promise.resolve({ workspace: "workspace1" }) }));
  for (const name of ["PayPal", "Orders v2", "JS SDK v6", "Server-side captures", "Payments v2 refunds", "signature verification", "Transaction Search", "APIMatic", "Bryntum Scheduler", "AG Studio", "Studio Agent Framework", "Custom tools", "WebMCP bridge", "Gemini interpretation", "Deterministic solver", "Why money never depends on the model", "Rules (AI busy)"]) expect(html).toContain(name);
  for (const section of ["paypal", "bryntum", "ag-studio", "ai", "webmcp"]) expect(html).toContain(`id="${section}"`);
  for (const href of ["/w/workspace1/book", "/w/workspace1", "/w/workspace1/dashboard#recovery-analyst", "/agent-ready"]) expect(html).toContain(`href="${href}"`);
  expect(html.match(/<table>/g)).toHaveLength(4);
  const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((match) => match[1]).filter((row) => !row.includes('scope="col"'));
  for (const row of rows) {
    expect(row).toMatch(/href="https:\/\/github.com\/harsha31bs07-blip\/rebook\/blob\/main\/[^"#]+#L\d+-L\d+" target="_blank" rel="noreferrer"/);
    expect(row).toMatch(/View code: [^<]+\.(tsx|ts)/);
  }
});
