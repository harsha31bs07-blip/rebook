import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DomConfig, EventModel } from "@bryntum/scheduler";
import type { BryntumSchedulerProps } from "@bryntum/scheduler-react";
import type { PlanDetails, PublicPlan } from "../lib/client/api";
import Schedule from "../components/console/schedule";
import PlanPanel from "../components/console/plan-panel";
import { replan } from "../lib/solver/replan";
import { localParts } from "../lib/domain/time";
import { recoveryDropStart, scheduleRange } from "../lib/client/scheduler-mapping";
import { adjustmentFixture, disruption } from "./adjust-fixture";
import { demoDisruption, seedStudio } from "../lib/seed/seed";

const harness = vi.hoisted(() => ({ eventId: "s1-new", target: undefined as Date | undefined,
  effects: [] as (() => unknown)[], scrollToDate: vi.fn(), zoomToLevel: vi.fn(), scrollEventIntoView: vi.fn(),
  commit: vi.fn().mockResolvedValue(undefined), setSpan: vi.fn().mockResolvedValue(undefined), coordinate: vi.fn().mockReturnValue(480), horizontal: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, vi.fn()],
  useRef: (initial: unknown) => ({ current: initial ?? { instance: {
    resolveEventRecord: () => ({ id: harness.eventId }), getDateFromDomEvent: () => harness.target,
    scrollToDate: harness.scrollToDate, zoomToLevel: harness.zoomToLevel,
    project: { commitAsync: harness.commit }, getCoordinateFromDate: harness.coordinate, scrollHorizontallyTo: harness.horizontal,
    setTimeSpan: harness.setSpan,
    scrollEventIntoView: harness.scrollEventIntoView, eventStore: { getById: (id: string) => ({ id }) },
  } } }),
  useEffect: (effect: () => unknown) => { harness.effects.push(effect); },
}));
vi.mock("@bryntum/scheduler-react", () => ({ BryntumScheduler: () => null }));
vi.mock("@bryntum/scheduler", () => ({ StringHelper: { encodeHtml: (text: string) => text },
  TimeZoneHelper: { toTimeZone: (date: Date, timezone: string) => {
    const local = localParts(date.toISOString(), timezone);
    return new Date(`${local.dateKey}T${String(Math.floor(local.minutesOfDay / 60)).padStart(2, "0")}:${String(local.minutesOfDay % 60).padStart(2, "0")}:00`);
  } },
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/solver/adjust", () => import("../lib/solver/adjust"));
vi.mock("@/lib/domain/time", () => import("../lib/domain/time"));
vi.mock("@/lib/client/scheduler-mapping", () => import("../lib/client/scheduler-mapping"));

const state = adjustmentFixture();
const plan = replan(state, disruption, { now: "2026-11-09T00:00:00Z" });
beforeEach(() => { harness.eventId = "s1-new"; harness.target = new Date("2026-11-10T17:45:00"); harness.effects = []; vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

function schedule(overrides: Partial<Parameters<typeof Schedule>[0]> = {}) {
  const root = Schedule({ state, plan, mode: "instructors", zoom: "week", day: 0, onAdjust: vi.fn().mockResolvedValue(undefined), onMove: vi.fn(), ...overrides });
  const props = (root.props.children[0] as ReactElement<BryntumSchedulerProps>).props;
  return { root, props };
}

function markup(config: DomConfig | DomConfig[] | string): string {
  if (typeof config === "string") return config;
  if (Array.isArray(config)) return config.map(markup).join("");
  const { tag = "div", text, children, ...attributes } = config;
  return renderToStaticMarkup(createElement(tag, attributes, text ?? (Array.isArray(children) ? children.map((child, index) => createElement("span", { key: index, dangerouslySetInnerHTML: { __html: markup(child as DomConfig) } })) : undefined)));
}
function eventMarkup(props: BryntumSchedulerProps, id: string) {
  const event = props.events!.find((item) => item.id === id)!;
  return markup(props.eventRenderer!({ eventRecord: event as EventModel, renderData: {} } as Parameters<NonNullable<BryntumSchedulerProps["eventRenderer"]>>[0]));
}

it("renders a native Move control for preview recovery blocks in Week and Day views only", () => {
  for (const zoom of ["week", "day"] as const) {
    const { props } = schedule({ zoom });
    expect(eventMarkup(props, "s1-new")).toContain('aria-label="Move Yoga to…"');
    expect(eventMarkup(props, "s1-new")).toContain('aria-haspopup="dialog"');
    expect(eventMarkup(props, "s1-original")).not.toContain("recovery-move");
    expect(eventMarkup(props, "s2")).not.toContain("recovery-move");
  }
  const { props } = schedule({ plan: undefined });
  expect(eventMarkup(props, "s1")).not.toContain("recovery-move");
  expect(eventMarkup(schedule({ busy: true }).props, "s1-new")).toContain('disabled=""');
});

it("starts scheduler accessible names with the visible class and time before status and badges", () => {
  for (const id of ["s1-original", "s1-new", "s2"]) {
    const { props } = schedule({ zoom: "day" });
    const event = props.events!.find((item) => item.id === id)!;
    const renderData = {} as { ariaLabel: string };
    const config = props.eventRenderer!({ eventRecord: event as EventModel, renderData } as Parameters<NonNullable<BryntumSchedulerProps["eventRenderer"]>>[0]);
    const label = renderData.ariaLabel;
    // Label in name: the accessible name starts with exactly the visible text, in order.
    const parts = (config as { children: { tag: string; text?: string }[] }[])[0].children.filter((child) => child.tag !== "button").map((child) => child.text?.trim());
    expect(label.startsWith(`${parts.join(" ")}. `)).toBe(true);
    const visible = markup(config);
    expect(visible).toContain(parts[1]!);
    if (id === "s1-new") expect(label).toContain("Covered by Alex");
  }
});

it("opens Move from Enter, Space and the button before Bryntum handles the event", () => {
  for (const zoom of ["week", "day"] as const) {
    const onMove = vi.fn();
    const { root } = schedule({ zoom, onMove });
    for (const key of ["Enter", " "]) {
      const event = { key, target: {}, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      root.props.onKeyDownCapture(event);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
    }
    root.props.onClickCapture({ target: { closest: () => ({}) }, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(onMove.mock.calls).toEqual([["s1"], ["s1"], ["s1"]]);
    harness.eventId = "s1-original";
    root.props.onKeyDownCapture({ key: "Enter", target: {}, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(onMove).toHaveBeenCalledTimes(3);
    harness.eventId = "s1-new";
  }
  const onMove = vi.fn();
  schedule({ busy: true, onMove }).root.props.onKeyDownCapture({ key: "Enter", target: {} });
  expect(onMove).not.toHaveBeenCalled();
});

it("allows recovery drags and preserves the clock in Week cells while Day uses hourly positioning", async () => {
  for (const zoom of ["week", "day"] as const) for (const mode of ["instructors", "rooms"] as const) {
    const onAdjust = vi.fn().mockResolvedValue(undefined);
    const { props } = schedule({ zoom, mode, onAdjust });
    const domEvent = { target: { closest: () => null } };
    const canDrag = props.onBeforeEventDrag as (input: unknown) => boolean;
    expect(canDrag({ eventRecord: { id: "s1-new" }, domEvent })).toBe(true);
    expect(canDrag({ eventRecord: { id: "s1-original" }, domEvent })).toBe(false);
    const targetId = mode === "instructors" ? "i1" : "r2";
    const drop = { eventRecord: { id: "s1-new" }, startDate: new Date("2026-11-10T11:15:00"), endDate: new Date("2026-11-10T12:15:00") };
    const context = { eventRecords: [{ id: "s1-new" }], newResource: { id: targetId }, startDate: drop.startDate, dropData: { events: [drop] }, valid: true, finalize: vi.fn() };
    const feature = props.eventDragFeature as { validatorFn: (input: unknown, event: unknown) => unknown };
    expect(feature.validatorFn(context, domEvent)).toMatchObject({ valid: true });
    (props.onBeforeEventDropFinalize as (input: unknown) => void)({ context, domEvent });
    await Promise.resolve();
    expect(onAdjust).toHaveBeenCalledWith({ sessionId: "s1", start: zoom === "week" ? "2026-11-10T10:00:00.000Z" : "2026-11-10T11:15:00.000Z", [mode === "instructors" ? "instructorId" : "roomId"]: targetId });
    expect(context.finalize).toHaveBeenCalledWith(true);
    expect(drop.startDate.getHours()).toBe(zoom === "week" ? 10 : 11);
    expect(drop.endDate.getTime() - drop.startDate.getTime()).toBe(3_600_000);
  }
});

it("snaps rejected server adjustments back", async () => {
  const onAdjust = vi.fn().mockRejectedValue(new Error("Alex already teaches at 12:15 PM."));
  const { props } = schedule({ onAdjust });
  const context = { eventRecords: [{ id: "s1-new" }], newResource: { id: "i2" }, startDate: new Date("2026-11-10T10:00:00"), dropData: { events: [] }, valid: true, finalize: vi.fn() };
  (props.onBeforeEventDropFinalize as (input: unknown) => void)({ context, domEvent: {} });
  await Promise.resolve();
  expect(context.finalize).toHaveBeenCalledWith(false);
});

it("bounds the configured week by studio-local Monday midnight through Sunday 24:00", () => {
  const zoned = structuredClone(state);
  zoned.studio.timezone = "America/New_York";
  zoned.studio.weekStart = "2026-10-26T04:00:00.000Z";
  const { props } = schedule({ state: zoned, plan: undefined });
  expect(props.startDate).toBe("2026-10-26T04:00:00.000Z");
  expect(props.endDate).toBe("2026-11-02T05:00:00.000Z");
  expect(props.autoAdjustTimeAxis).toBe(false);
  expect(recoveryDropStart("2026-10-26T14:15:00Z", new Date("2026-11-01T18:00:00"), zoned.studio.timezone, "week")).toBe("2026-11-01T15:15:00.000Z");
});

it("preview and applied-plan focus scroll inside the fixed workspace week, including a DST boundary", async () => {
  const zoned = structuredClone(state);
  zoned.studio.timezone = "America/New_York";
  zoned.studio.weekStart = "2026-10-26T04:00:00.000Z";
  const focused = structuredClone(plan);
  focused.disruption.from = "2026-10-28T04:00:00Z";
  focused.disruption.to = "2026-10-29T04:00:00Z";
  focused.sessionChanges = [];
  expect(scheduleRange(zoned, "week", 0, focused)).toMatchObject({ startKey: "2026-10-26", endKey: "2026-11-02",
    start: "2026-10-26T04:00:00.000Z", end: "2026-11-02T05:00:00.000Z", focusKey: "2026-10-28" });
  for (const preview of [true, false]) {
    harness.effects = [];
    harness.horizontal.mockClear();
    const { props } = schedule({ state: zoned, plan: preview ? focused : undefined, updatedPlan: preview ? undefined : focused });
    harness.effects[1]();
    await vi.waitFor(() => expect(harness.horizontal).toHaveBeenCalled());
    expect(props.startDate).toBe("2026-10-26T04:00:00.000Z");
    expect(props.endDate).toBe("2026-11-02T05:00:00.000Z");
    expect(harness.commit).toHaveBeenCalled();
    expect(harness.setSpan).toHaveBeenLastCalledWith(new Date("2026-10-26T00:00:00"), new Date("2026-11-02T00:00:00"));
    expect(harness.coordinate).toHaveBeenLastCalledWith(new Date("2026-10-28T07:00:00"), { local: true });
    expect(harness.horizontal).toHaveBeenLastCalledWith(480, { animate: false });
    expect(harness.scrollToDate).not.toHaveBeenCalled();
    expect(harness.zoomToLevel).not.toHaveBeenCalled();
  }
  focused.disruption.from = "2026-10-22T00:00:00Z";
  expect(scheduleRange(zoned, "week", 0, focused).focusKey).toBe("2026-10-26");
});

it("scrolls an accepted placement into view and highlights it without expanding a Day view", async () => {
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { callback(); return 1; });
  const { props } = schedule({ highlightedSessionId: "s1" });
  harness.effects[2]();
  await vi.waitFor(() => expect(harness.scrollEventIntoView).toHaveBeenCalled());
  expect(props.events!.find((item) => item.id === "s1-new")?.cls).toContain("new-booking-highlight");
  expect(harness.scrollEventIntoView).toHaveBeenCalledWith({ id: "s1-new" }, { block: "nearest", inline: "nearest", animate: false, extendTimeAxis: false });
  harness.scrollEventIntoView.mockClear(); harness.effects = [];
  schedule({ highlightedSessionId: "s1", zoom: "day", day: 1 });
  harness.effects[2]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(harness.scrollEventIntoView).not.toHaveBeenCalled();
});

it("lists changed sessions with Move links in preview and says Recovery applied while replies are outstanding", () => {
  const publicPlan: PublicPlan = { ...plan, id: "plan", workspaceId: "workspace", status: "proposed", createdAt: "2026-11-09T00:00:00Z", results: [] };
  const details: PlanDetails = { plan: publicPlan, sessions: state.sessions, messages: [], explanation: { headline: "Your recovery preview", bullets: [], source: "template" } };
  const props = { details, plan: publicPlan, state, busy: false, results: [], onMove: vi.fn(), onApprove: vi.fn(), onDiscard: vi.fn(), onMessages: vi.fn() };
  const preview = renderToStaticMarkup(createElement(PlanPanel, props));
  expect(preview).toContain("Yoga");
  expect(preview).toContain("Move...</button>");
  const executed = renderToStaticMarkup(createElement(PlanPanel, { ...props, plan: { ...publicPlan, status: "executed" } }));
  expect(executed).toContain('<h2 tabindex="-1">Recovery applied</h2>');
  expect(executed).toContain("haven&#x27;t replied");
  expect(executed).not.toContain("move-session-link");
  expect(renderToStaticMarkup(createElement(PlanPanel, { ...props, busy: true }))).not.toContain("Processing refunds");
  expect(renderToStaticMarkup(createElement(PlanPanel, { ...props, busy: true, approving: true }))).toContain("Processing refunds");
  const pending = { ...props, plan: { ...publicPlan, status: "executed" as const }, results: [{ bookingId: "b1", status: "PENDING" }] };
  expect(renderToStaticMarkup(createElement(PlanPanel, pending))).toContain("Check refund status</button>");
  expect(renderToStaticMarkup(createElement(PlanPanel, { ...pending, busy: true }))).toContain("Checking refund status");
  expect(executed).not.toContain("Check refund status");
  expect(renderToStaticMarkup(createElement(PlanPanel, { ...pending, plan: { ...pending.plan, status: "partially_failed" } }))).toContain("Retry</button>");
});

it("compares an owner's adjustment with the previous version's totals beside Undo", () => {
  const publicPlan: PublicPlan = { ...plan, id: "plan", workspaceId: "workspace", status: "proposed", createdAt: plan.now, results: [],
    totals: { ...plan.totals, refunded: 9, revenueKept: "18.00" },
    lastAdjustmentTotals: { ...plan.totals, refunded: 1, revenueKept: "194.00" } };
  const details: PlanDetails = { plan: publicPlan, sessions: state.sessions, messages: [], explanation: { headline: "Adjusted recovery", bullets: [], source: "template" } };
  const props = { details, plan: publicPlan, state, busy: false, results: [], onUndo: vi.fn(), onApprove: vi.fn(), onDiscard: vi.fn(), onMessages: vi.fn() };
  const html = renderToStaticMarkup(createElement(PlanPanel, props));
  expect(html).toContain('role="status"');
  expect(html).toContain("Your change: 8 more refunds, −$176.00 revenue kept (vs previous version).");
  expect(html).toContain("Undo last adjustment");
  const noDifference = renderToStaticMarkup(createElement(PlanPanel, { ...props, plan: { ...publicPlan, lastAdjustmentTotals: publicPlan.totals } }));
  expect(noDifference).toContain("Your change: no change in refunds, $0.00 revenue kept");
  const improvement = renderToStaticMarkup(createElement(PlanPanel, { ...props, plan: { ...publicPlan, totals: publicPlan.lastAdjustmentTotals, lastAdjustmentTotals: publicPlan.totals } as PublicPlan }));
  expect(improvement).toContain("8 fewer refunds, +$176.00 revenue kept");
});

it("derives owner work estimates from the current plan and displays API planning time only when measured", () => {
  const state = seedStudio();
  const publicPlan: PublicPlan = { ...replan(state, demoDisruption), id: "plan", workspaceId: "workspace", status: "proposed", createdAt: plan.now, results: [], planningDurationMs: 2800 };
  const details: PlanDetails = { plan: publicPlan, sessions: state.sessions, messages: [], explanation: { headline: "Recovery preview", bullets: [], source: "template" } };
  const props = { details, plan: publicPlan, state, busy: false, results: [], onApprove: vi.fn(), onDiscard: vi.fn(), onMessages: vi.fn() };
  const html = renderToStaticMarkup(createElement(PlanPanel, props));
  expect(html).toContain("Owner time saved (estimate)");
  expect(html).toContain("Prepared in 2.8 s · replaces about 31 calls or messages once you share the links, plus 6 manual refunds");
  const changed = { ...publicPlan, planningDurationMs: undefined, bookingActions: publicPlan.bookingActions.slice(0, 2), totals: { ...publicPlan.totals, refunded: 1 } };
  const adjusted = renderToStaticMarkup(createElement(PlanPanel, { ...props, plan: changed }));
  expect(adjusted).not.toContain("Prepared in");
  expect(adjusted).toContain("replaces about 2 calls or messages once you share the links, plus 1 manual refund.");
});
