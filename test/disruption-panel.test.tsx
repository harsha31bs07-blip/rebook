import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { demoDisruption, seedStudio } from "../lib/seed/seed";
import type { Interpretation } from "../lib/ai/interpret";

const hooks = vi.hoisted(() => ({ refs: [] as { current: unknown }[], effects: [] as (() => void)[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: () => { const ref = { current: null }; hooks.refs.push(ref); return ref; },
  useEffect: (effect: () => void) => hooks.effects.push(effect),
}));
vi.mock("@/lib/client/scheduler-mapping", () => import("../lib/client/scheduler-mapping"));
import DisruptionPanel from "../components/console/disruption-panel";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
beforeEach(() => { hooks.refs = []; hooks.effects = []; });

const clarification: Interpretation = {
  kind: "clarify", question: "Which days are affected?", suggestions: ["Maya unavailable Monday only", "Maya unavailable Monday to Wednesday"],
};
function panel(busy = false) {
  const props = { state: seedStudio(), text: "Maya unavailable until Wednesday", setText: vi.fn(), interpretation: clarification,
    onInterpret: vi.fn(async () => clarification), onReport: vi.fn(async () => clarification), onEdit: vi.fn(), onPlan: vi.fn(), busy };
  return { tree: DisruptionPanel(props), props };
}

it("labels the suggestions, focuses the clarification question and keeps the editor available", () => {
  const { tree } = panel();
  const all = elements(tree), question = all.find((element) => element.type === "h3" && element.props.id === "clarification-question")!;
  expect(question.props.tabIndex).toBe(-1);
  const focus = vi.fn();
  (question.props.ref as { current: unknown }).current = { focus };
  hooks.effects.forEach((effect) => effect());
  expect(focus).toHaveBeenCalledOnce();
  expect(all.find((element) => element.props.role === "group")?.props["aria-labelledby"]).toBe(question.props.id);
  expect(all.some((element) => element.type === "textarea")).toBe(true);
  expect(all.some((element) => element.props.id === "judge-plan")).toBe(false);
  const html = renderToStaticMarkup(tree);
  expect(html).toContain("Which days are affected?");
  expect(html).not.toContain("Classes affected:");
});

it("reinterprets a complete replacement statement with one tap and never plans", () => {
  const { tree, props } = panel();
  const button = elements(tree).find((element) => element.type === "button" && element.props.children === clarification.suggestions[1])!;
  (button.props.onClick as () => void)();
  expect(props.setText).toHaveBeenCalledExactlyOnceWith(clarification.suggestions[1]);
  expect(props.onInterpret).toHaveBeenCalledExactlyOnceWith(clarification.suggestions[1]);
  expect(props.onPlan).not.toHaveBeenCalled();
});

it("disables suggestion buttons while interpretation is in flight", () => {
  const { tree } = panel(true);
  const group = elements(tree).find((element) => element.props.role === "group")!;
  expect(elements(group).filter((element) => element.type === "button").every((element) => element.props.disabled)).toBe(true);
});

it("describes a multi-day all-day window without narrowing its assumption to Monday", () => {
  const { props } = panel();
  const html = renderToStaticMarkup(DisruptionPanel({ ...props, text: "Maya unavailable Monday to Wednesday", interpretation: {
    disruption: { ...demoDisruption, to: "2026-11-12T05:00:00Z" }, confidence: 0.85, source: "rules", notes: [],
  } }));
  expect(html).toContain("Assumed all day throughout this window.");
  expect(html).not.toContain("Assumed all day Monday.");
});
