import { type ReactElement, type ReactNode, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { moveDayLabel, moveTimeOptions } from "../lib/client/move-options";
import { replan } from "../lib/solver/replan";
import { adjustmentFixture, disruption } from "./adjust-fixture";

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => (() => void))[] }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (next: unknown) => { hooks.slots[index] = next; }];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: (effect: () => (() => void)) => { hooks.effects.push(effect); },
}));
import MoveToPopover from "../components/console/move-to-popover";

const state = adjustmentFixture();
const plan = replan(state, disruption, { now: "2026-11-09T00:00:00Z" });
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function render(overrides: Partial<Parameters<typeof MoveToPopover>[0]> = {}) {
  hooks.cursor = 0;
  return MoveToPopover({ state, plan, sessionId: "s1", busy: false, onAdjust: vi.fn().mockResolvedValue(undefined), onClose: vi.fn(), ...overrides });
}
beforeEach(() => { hooks.cursor = 0; hooks.slots = []; hooks.effects = []; });
afterEach(() => vi.unstubAllGlobals());

it("labels days and offers 12-hour times only within opening hours minus the class length", () => {
  expect(moveDayLabel("2026-10-27")).toBe("Tue Oct 27");
  const options = moveTimeOptions(state, state.sessions[0], "2026-11-10");
  expect(options[0]).toMatchObject({ value: "07:00", label: "7:00 AM" });
  expect(options.at(-1)).toMatchObject({ value: "20:00", label: "8:00 PM" });
  expect(options).toHaveLength(53);
  expect(options.find((item) => item.value === "15:00")?.label).toBe("3:00 PM");
});

it("honours closed days, split opening hours, longer classes and the studio timezone", () => {
  const changed = structuredClone(state);
  changed.studio.timezone = "America/New_York";
  changed.studio.openHours[2] = [{ open: "07:00", close: "09:00" }, { open: "17:00", close: "18:00" }];
  const session = { ...changed.sessions[0], end: "2026-11-09T11:30:00.000Z" };
  const options = moveTimeOptions(changed, session, "2026-11-10");
  expect(options.map((item) => item.value)).toEqual(["07:00", "07:15", "07:30"]);
  expect(options[0].start).toBe("2026-11-10T12:00:00.000Z");
  changed.studio.openHours[2] = [];
  expect(moveTimeOptions(changed, session, "2026-11-10")).toEqual([]);
});

it("names the modal and its four selects; changing to a closed day prevents submission", () => {
  const changed = structuredClone(state);
  changed.studio.openHours[2] = [];
  const onAdjust = vi.fn();
  let root = render({ state: changed, onAdjust });
  const html = renderToStaticMarkup(root);
  expect(html).toContain('aria-labelledby="move-to-title"');
  for (const label of ["Day", "Time", "Instructor", "Room"]) expect(html).toContain(`<label>${label}<select`);
  expect(html).toContain("Mon Nov 9");
  expect(html).toContain("3:00 PM");
  const day = elements(root).find((item) => item.type === "select")!;
  (day.props.onChange as (event: unknown) => void)({ target: { value: "2026-11-10" } });
  root = render({ state: changed, onAdjust });
  expect(renderToStaticMarkup(root)).toContain("No times available");
  const submit = elements(root).find((item) => item.type === "button" && item.props.type === "submit")!;
  expect(submit.props.disabled).toBe(true);
  (elements(root).find((item) => item.type === "form")!.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() });
  expect(onAdjust).not.toHaveBeenCalled();
});

it("opens a native modal for browser focus containment, focuses Day, handles Esc and restores the trigger", () => {
  const onClose = vi.fn();
  const root = render({ onClose });
  const modal = { showModal: vi.fn(), close: vi.fn() };
  const first = { focus: vi.fn() };
  const trigger = { isConnected: true, focus: vi.fn() };
  vi.stubGlobal("document", { activeElement: trigger });
  (root.props.ref as RefObject<unknown>).current = modal;
  (elements(root).find((item) => item.type === "select")!.props.ref as RefObject<unknown>).current = first;
  const cleanup = hooks.effects[0]();
  expect(modal.showModal).toHaveBeenCalledOnce();
  expect(first.focus).toHaveBeenCalledOnce();
  root.props.onCancel({ preventDefault: vi.fn() });
  expect(onClose).toHaveBeenCalledOnce();
  cleanup();
  expect(modal.close).toHaveBeenCalledOnce();
  expect(trigger.focus).toHaveBeenCalledOnce();
});
