import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode, SetStateAction } from "react";
import type { PlanDetails, PublicPlan } from "../lib/client/api";
import type { State } from "../lib/domain/types";
import { adjustmentFixture, disruption } from "./adjust-fixture";
import { replan } from "../lib/solver/replan";
import { planCorrection } from "../lib/solver/correction";
import { activateConstraint } from "../lib/solver/constraints";
import { applyPlan } from "../lib/solver/validate";
import { adjustPlan, type OwnerAdjustment } from "../lib/solver/adjust";

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], phone: false,
  details: undefined as PlanDetails | undefined, state: undefined as State | undefined }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => hooks.slots[hooks.cursor++] ??= { current: initial },
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value; }];
  },
  useEffect: () => {},
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/lib/client/api", () => import("../lib/client/api"));
vi.mock("@/lib/client/scheduler-mapping", () => import("../lib/client/scheduler-mapping"));
vi.mock("@/lib/domain/time", () => import("../lib/domain/time"));
vi.mock("../lib/webmcp/use-webmcp", () => ({ useWebMcp: () => {} }));
vi.mock("../components/console/use-schedule-view", () => ({ useScheduleView: () => ({ phone: hooks.phone, view: hooks.phone ? "list" : "timeline", setView: vi.fn() }) }));
vi.mock("../components/console/use-plan-preview", () => ({ usePlanPreview: () => ({
  details: hooks.details, basis: hooks.state, setBasis: vi.fn(),
  setDetails: (value: SetStateAction<PlanDetails | undefined>) => { hooks.details = typeof value === "function" ? value(hooks.details) : value; },
}) }));
vi.mock("../components/console/use-workspace", () => ({ useWorkspace: () => ({ workspace: {
  state: hooks.state, plans: [], status: "ready", progress: { done: 1, total: 1 },
}, refresh: vi.fn().mockResolvedValue(undefined) }) }));
import OwnerConsole from "../components/console/owner-console";
import PlanPanel from "../components/console/plan-panel";
import ScheduleAgenda from "../components/console/schedule-agenda";
import MoveToPopover from "../components/console/move-to-popover";
import { api } from "../lib/client/api";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...elements(element.props.children as ReactNode)];
}
function render() { hooks.cursor = 0; return elements(OwnerConsole({ id: "workspace" })); }
beforeEach(() => {
  hooks.cursor = 0; hooks.slots = []; hooks.phone = false;
  const basis = adjustmentFixture();
  const original = { ...replan(basis, disruption, { now: "2026-11-09T00:00:00Z" }), id: "original", basis };
  hooks.state = activateConstraint(applyPlan(basis, original), disruption);
  const correction: PublicPlan = { ...planCorrection(hooks.state, original, original.now),
    id: "correction", workspaceId: "workspace", status: "proposed", createdAt: original.now, results: [] };
  hooks.details = { plan: correction, sessions: hooks.state.sessions, messages: [], explanation: { headline: "Correction ready", source: "template", bullets: [] } };
});
afterEach(() => vi.restoreAllMocks());

it.each([false, true])("enables correction Move controls and announces the saved placement (phone: %s)", async (phone) => {
  hooks.phone = phone;
  const original = hooks.details!.plan;
  const input = { sessionId: "s1", start: "2026-11-09T14:00:00Z" };
  const adjusted: PublicPlan = { ...original, ...adjustPlan(hooks.state!, original, input), version: 2,
    lastAdjustment: original.sessionChanges[0], lastAdjustmentTotals: original.totals };
  const save = vi.spyOn(api, "adjust").mockResolvedValue(adjusted);
  let tree = render();
  const panel = tree.find((element) => element.type === PlanPanel)!;
  expect(panel.props.onMove).toBeTypeOf("function");
  if (phone) expect(tree.find((element) => element.type === ScheduleAgenda)?.props.onMove).toBeTypeOf("function");
  else {
    expect(tree.some((element) => typeof element.props.onAdjust === "function")).toBe(true);
    expect(renderToStaticMarkup(tree.find((element) => element.props.className === "preview-key")!)).toContain("Drag a restored block to fine-tune it, use Move, or focus it and press Enter / Space");
  }
  (panel.props.onMove as (sessionId: string) => void)("s1");
  const popover = render().find((element) => element.type === MoveToPopover)!;
  expect(popover).toBeDefined();
  await (popover.props.onAdjust as (input: OwnerAdjustment) => Promise<void>)(input);
  expect(save).toHaveBeenCalledWith("workspace", "correction", input, 1);
  expect(hooks.details?.explanation.headline).toBe("Your adjusted correction is ready");
  expect(hooks.details?.messages).toHaveLength(2);
  tree = render();
  expect(tree.find((element) => element.type === PlanPanel)?.props.onUndo).toBeTypeOf("function");
  const status = tree.find((element) => element.props.role === "status" && element.props["aria-live"] === "polite")!;
  expect(status.props.children).toBe("Class moved. Review the restored placement.");
});

it("keeps approved correction placements read-only", () => {
  hooks.details!.plan.status = "executed";
  const tree = render();
  expect(tree.find((element) => element.type === PlanPanel)?.props.onMove).toBeUndefined();
  expect(tree.some((element) => typeof element.props.onAdjust === "function")).toBe(false);
});
