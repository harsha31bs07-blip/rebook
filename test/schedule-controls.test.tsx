import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { DomConfig, EventModel } from "@bryntum/scheduler";
import type { BryntumSchedulerProps } from "@bryntum/scheduler-react";
import type { PlanDetails, PublicPlan } from "../lib/client/api";
import Schedule from "../components/console/schedule";
import PlanPanel from "../components/console/plan-panel";
import { replan } from "../lib/solver/replan";
import { localParts } from "../lib/domain/time";
import { recoveryDropStart } from "../lib/client/scheduler-mapping";
import { adjustmentFixture, disruption } from "./adjust-fixture";

const harness = vi.hoisted(() => ({ eventId: "s1-new", target: undefined as Date | undefined }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, vi.fn()],
  useRef: (initial: unknown) => ({ current: initial ?? { instance: {
    resolveEventRecord: () => ({ id: harness.eventId }), getDateFromDomEvent: () => harness.target,
  } } }),
  useEffect: () => {},
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
beforeEach(() => { harness.eventId = "s1-new"; harness.target = new Date("2026-11-10T17:45:00"); });

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

it("lists changed sessions with Move links in preview and says Recovery complete after approval", () => {
  const publicPlan: PublicPlan = { ...plan, id: "plan", workspaceId: "workspace", status: "proposed", createdAt: "2026-11-09T00:00:00Z", results: [] };
  const details: PlanDetails = { plan: publicPlan, sessions: state.sessions, messages: [], explanation: { headline: "Your recovery preview", bullets: [], source: "template" } };
  const props = { details, plan: publicPlan, state, busy: false, results: [], onMove: vi.fn(), onApprove: vi.fn(), onDiscard: vi.fn(), onMessages: vi.fn() };
  const preview = renderToStaticMarkup(createElement(PlanPanel, props));
  expect(preview).toContain("Yoga");
  expect(preview).toContain("Move...</button>");
  const executed = renderToStaticMarkup(createElement(PlanPanel, { ...props, plan: { ...publicPlan, status: "executed" } }));
  expect(executed).toContain("<h2>Recovery complete</h2>");
  expect(executed).not.toContain("move-session-link");
});
