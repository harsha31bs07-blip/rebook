import { readFileSync } from "node:fs";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import type { PlanDetails, PublicPlan } from "../lib/client/api";
import { adjustmentFixture, disruption } from "./adjust-fixture";
import { replan } from "../lib/solver/replan";
import { adjustPlan } from "../lib/solver/adjust";

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], phone: false,
  subscribe: undefined as ((notify: () => void) => () => void) | undefined }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => hooks.slots[hooks.cursor++] ??= { current: initial },
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value; }];
  },
  useEffect: (effect: () => void, deps: unknown[]) => {
    const index = hooks.cursor++, previous = hooks.slots[index] as unknown[] | undefined;
    if (!previous || deps.some((value, position) => value !== previous[position])) { hooks.slots[index] = deps; hooks.effects.push(effect); }
  },
  useSyncExternalStore: (subscribe: typeof hooks.subscribe, snapshot: () => unknown) => { hooks.subscribe = subscribe; return snapshot(); },
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/lib/client/api", () => import("../lib/client/api"));
vi.mock("@/lib/client/scheduler-mapping", () => import("../lib/client/scheduler-mapping"));
vi.mock("@/lib/domain/time", () => import("../lib/domain/time"));
vi.mock("../lib/webmcp/use-webmcp", () => ({ useWebMcp: () => {} }));
vi.mock("../components/console/use-plan-preview", () => ({ usePlanPreview: () => ({}) }));
vi.mock("../components/console/judge-hint", () => ({ default: () => null }));
vi.mock("../components/console/use-workspace", () => ({ useWorkspace: () => ({ workspace: {
  state: adjustmentFixture(), plans: [], status: "ready", progress: { done: 1, total: 1 },
}, refresh: vi.fn() }) }));
import ScheduleAgenda from "../components/console/schedule-agenda";
import PlanPanel, { ApprovalDialog, CoverRecord, RefundResults } from "../components/console/plan-panel";
import PaymentsAttention from "../components/console/payments-attention";
import { api } from "../lib/client/api";
import OwnerConsole from "../components/console/owner-console";
import { PHONE_QUERY, useScheduleView } from "../components/console/use-schedule-view";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...elements(element.props.children as ReactNode)];
}
function render<T>(view: () => T): T { hooks.cursor = 0; return view(); }
const state = adjustmentFixture();
const plan = replan(state, disruption, { now: "2026-11-09T00:00:00Z" });
beforeEach(() => {
  hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.phone = false;
  vi.stubGlobal("window", { matchMedia: vi.fn(() => ({ matches: hooks.phone, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("shows live bounded-batch progress and a clear Needs review refund result", () => {
  const publicPlan: PublicPlan = { ...plan, totals: { ...plan.totals, refunded: 6 }, id: "plan", workspaceId: "workspace", status: "executing",
    createdAt: plan.now, results: [], refundProgress: { done: 3, total: 6 } };
  const details: PlanDetails = { plan: publicPlan, sessions: state.sessions, messages: [], explanation: { headline: "Recovery", source: "template", bullets: [] } };
  const html = renderToStaticMarkup(render(() => PlanPanel({ details, plan: publicPlan, state, busy: true, results: [], onApprove: vi.fn(), onDiscard: vi.fn(), onMessages: vi.fn() })));
  expect(html).toContain("3 of 6 complete");
  const result = renderToStaticMarkup(<RefundResults state={state} results={[{ bookingId: state.bookings[0].id, status: "NEEDS_REVIEW", error: "Automatic retry is paused to avoid a duplicate." }]} />);
  expect(result).toContain("Needs review"); expect(result).toContain("avoid a duplicate");
});

it("lists an unresolved partial refund with its age and checks PayPal without approving another refund", async () => {
  const check = vi.spyOn(api, "checkRefund").mockResolvedValue({ kind: "unknown" });
  const approve = vi.spyOn(api, "approve");
  const onUpdated = vi.fn();
  const props = { workspaceId: "workspace", payments: [{ requestId: "partial", bookingId: "b1", status: "NEEDS_REVIEW", amount: "4.00",
    customer: "Customer", since: "2026-10-28T00:00:00Z", ageMinutes: 70, message: "Upstream diagnostics stay private" }], onUpdated };
  let tree = render(() => PaymentsAttention(props));
  const html = renderToStaticMarkup(tree);
  expect(html).toContain("Payments needing attention"); expect(html).toContain("Needs review");
  expect(html).toContain("70 min ago"); expect(html).toContain("$4.00");
  expect(html).not.toContain("Upstream diagnostics");
  (elements(tree).find((element) => element.type === "button")!.props.onClick as () => void)();
  await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledOnce());
  expect(check).toHaveBeenCalledWith("workspace", "partial"); expect(approve).not.toHaveBeenCalled();
  tree = render(() => PaymentsAttention(props));
  expect(renderToStaticMarkup(tree)).toContain("The amount stays reserved");
});

it("groups agenda cards by local day with original/recovery badges, room, occupancy and Move", () => {
  const moved = adjustPlan(state, plan, { sessionId: "s1", start: "2026-11-10T10:00:00Z" });
  const html = renderToStaticMarkup(<ScheduleAgenda state={state} plan={moved} onMove={vi.fn()} />);
  expect(html).toContain('aria-labelledby="agenda-2026-11-09"');
  expect(html).toContain('aria-labelledby="agenda-2026-11-10"');
  expect(html.indexOf("Monday, Nov 9")).toBeLessThan(html.indexOf("Tuesday, Nov 10"));
  expect(html).toContain("<h4>Yoga · Original</h4>"); expect(html).toContain("<h4>Yoga · Recovery</h4>");
  expect(html).toContain("Adjusted by you"); expect(html).toContain("Alex · Hall"); expect(html).toContain("1/10 booked");
  expect(html).toContain('data-move-session="s1"'); expect(html).toContain("Move Yoga to…");
  expect(html).toContain('<ul role="list"><li');
  const day = renderToStaticMarkup(<ScheduleAgenda state={state} plan={moved} zoom="day" day={1} />);
  expect(day).toContain("Tuesday, Nov 10"); expect(day).not.toContain("Monday, Nov 9"); expect(day).not.toContain("Yoga · Original");
});

it("shows covered and cancelled classes as readable statuses", () => {
  expect(renderToStaticMarkup(<ScheduleAgenda state={state} plan={plan} />)).toContain("Covered by Alex");
  const cancelled = { ...plan, sessionChanges: plan.sessionChanges.map((change) => ({ ...change, remedy: "cancel" as const, after: undefined })) };
  expect(renderToStaticMarkup(<ScheduleAgenda state={state} plan={cancelled} />)).toContain("Yoga · Cancelled");
});

it("defaults to List at the phone breakpoint and Timeline on desktop; preserves an explicit toggle", () => {
  expect(render(useScheduleView).view).toBe("timeline");
  hooks.phone = true;
  const phone = render(useScheduleView); expect(phone.phone).toBe(true); expect(phone.view).toBe("list");
  phone.setView("timeline"); expect(render(useScheduleView).view).toBe("timeline");
  expect(window.matchMedia).toHaveBeenCalledWith(PHONE_QUERY);
  const addEventListener = vi.fn(), removeEventListener = vi.fn();
  vi.mocked(window.matchMedia).mockReturnValue({ addEventListener, removeEventListener } as unknown as MediaQueryList);
  const notify = vi.fn(), unsubscribe = hooks.subscribe!(notify);
  expect(addEventListener).toHaveBeenCalledWith("change", notify); unsubscribe();
  expect(removeEventListener).toHaveBeenCalledWith("change", notify);
});

it("puts recovery first in phone DOM order, offers Timeline/List, and keeps the desktop schedule first", () => {
  const desktop = render(() => OwnerConsole({ id: "workspace" }));
  let all = elements(desktop);
  expect(all.findIndex((element) => element.props["aria-label"] === "Studio schedule")).toBeLessThan(all.findIndex((element) => element.type === "aside"));
  hooks.phone = true;
  const phone = render(() => OwnerConsole({ id: "workspace" })); all = elements(phone);
  expect(all.findIndex((element) => element.type === "aside")).toBeLessThan(all.findIndex((element) => element.props["aria-label"] === "Studio schedule"));
  expect(all.some((element) => element.type === ScheduleAgenda)).toBe(true);
  const controls = all.find((element) => element.props["aria-label"] === "Schedule view")!;
  const timeline = elements(controls).find((element) => element.props.children === "Timeline")!;
  (timeline.props.onClick as () => void)();
  const toggled = elements(render(() => OwnerConsole({ id: "workspace" })));
  expect(toggled.some((element) => element.type === ScheduleAgenda)).toBe(false);
  expect(toggled.find((element) => element.props.className === "timeline-panel timeline-view")).toBeDefined();
});

it("shows original/new placement and affected customers and focuses the result when approval applies", () => {
  const publicPlan: PublicPlan = { ...plan, id: "plan", workspaceId: "workspace", status: "proposed", createdAt: plan.now, results: [] };
  const details: PlanDetails = { plan: publicPlan, sessions: state.sessions, messages: [], explanation: { headline: "Recovery ready", source: "template", bullets: [] } };
  const props = { details, plan: publicPlan, state, busy: false, results: [], onApprove: vi.fn(), onDiscard: vi.fn(), onMessages: vi.fn() };
  const tree = render(() => PlanPanel(props)), html = renderToStaticMarkup(tree);
  expect(html).toContain("Originally: Mon 10:00 AM · Maya"); expect(html).toContain("New: "); expect(html).toContain("3 affected customers");
  hooks.effects.splice(0).forEach((effect) => effect());
  const result = render(() => PlanPanel({ ...props, plan: { ...publicPlan, status: "executed" } }));
  const heading = elements(result).find((element) => element.type === "h2" && element.props.tabIndex === -1)!;
  const focus = vi.fn(); (heading.props.ref as { current: unknown }).current = { focus };
  hooks.effects.splice(0).forEach((effect) => effect()); expect(focus).toHaveBeenCalledOnce();
  expect(renderToStaticMarkup(result)).toContain("in the new schedule");
});

it("reviews unconfirmed covers before approval and sends only checked owner attestations", () => {
  const covered = plan.sessionChanges.find((change) => change.after && change.after.instructorId !== change.before.instructorId)!;
  const publicPlan: PublicPlan = { ...plan, sessionChanges: [covered, { ...covered, sessionId: "second-covered" }], id: "plan", workspaceId: "workspace", version: 1, status: "proposed", createdAt: plan.now, results: [] };
  const details: PlanDetails = { plan: publicPlan, sessions: state.sessions, messages: [], explanation: { headline: "Recovery ready", source: "template", bullets: [] } };
  const onApprove = vi.fn();
  const props = { details, plan: publicPlan, state, busy: false, results: [], onApprove, onDiscard: vi.fn(), onMessages: vi.fn() };
  const approveButton = (tree: ReactNode) => elements(tree).find((element) => element.props.id === "judge-approve")!;
  let tree = render(() => PlanPanel(props));
  expect(renderToStaticMarkup(tree)).toContain("Confirmed with Alex?");
  (approveButton(tree).props.onClick as () => void)();
  tree = render(() => PlanPanel(props));
  let dialog = elements(tree).find((element) => element.type === ApprovalDialog)!;
  expect(renderToStaticMarkup(dialog)).toContain("2 covers not yet confirmed");
  expect(renderToStaticMarkup(dialog)).toContain("Alex covers Yoga Mon 10:00 AM");
  expect(onApprove).not.toHaveBeenCalled();
  const checkbox = elements(tree).find((element) => element.type === "input" && element.props.type === "checkbox")!;
  (checkbox.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
  tree = render(() => PlanPanel(props)); dialog = elements(tree).find((element) => element.type === ApprovalDialog)!;
  expect(renderToStaticMarkup(dialog)).toContain("1 cover not yet confirmed");
  (dialog.props.onApprove as () => void)(); expect(onApprove).toHaveBeenCalledWith([covered.sessionId]);
  tree = render(() => PlanPanel(props));
  (approveButton(tree).props.onClick as () => void)();
  tree = render(() => PlanPanel({ ...props, plan: { ...publicPlan, version: 2 } }));
  expect(elements(tree).some((element) => element.type === ApprovalDialog)).toBe(false);
  expect(elements(tree).filter((element) => element.type === "input").every((element) => !element.props.checked)).toBe(true);
});

it("allows approval with no cover checks and shows who confirmed each cover in the recovery record", () => {
  const publicPlan: PublicPlan = { ...plan, id: "plan", workspaceId: "workspace", status: "proposed", createdAt: plan.now, results: [] };
  const props = { details: { plan: publicPlan, sessions: state.sessions, messages: [], explanation: { headline: "Ready", source: "template" as const, bullets: [] } }, plan: publicPlan, state, busy: false, results: [], onApprove: vi.fn(), onDiscard: vi.fn(), onMessages: vi.fn() };
  let tree = render(() => PlanPanel(props));
  (elements(tree).find((element) => element.props.id === "judge-approve")!.props.onClick as () => void)();
  tree = render(() => PlanPanel(props));
  (elements(tree).find((element) => element.type === ApprovalDialog)!.props.onApprove as () => void)();
  expect(props.onApprove).toHaveBeenCalledWith([]);
  const cover = plan.sessionChanges.find((change) => change.after && change.after.instructorId !== change.before.instructorId)!;
  const applied: PublicPlan = { ...publicPlan, status: "executed", coverConfirmations: [{ sessionId: cover.sessionId, instructorId: cover.after!.instructorId, confirmedBy: "Workspace owner", confirmedAt: plan.now }] };
  expect(renderToStaticMarkup(<CoverRecord plan={applied} state={state} />)).toContain("Confirmed by Workspace owner");
  expect(renderToStaticMarkup(<CoverRecord plan={{ ...applied, coverConfirmations: [] }} state={state} />)).toContain("Not yet confirmed");
});

it("scopes phone recovery flow, 44px targets and the persistent approve bar to <=760px", () => {
  const css = readFileSync("app/globals.css", "utf8");
  const phone = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
  expect(phone).toContain(".timeline-panel.agenda-view { height: auto; }");
  expect(phone).toMatch(/\.plan-actions\s*\{[^}]*position: fixed;[^}]*inset: auto 0 0/);
  expect(phone).toContain("min-height: 44px"); expect(phone).toContain("min-width: 680px");
  expect(phone).toContain(".timeline-view .schedule-canvas { overflow-x: auto; }");
});
