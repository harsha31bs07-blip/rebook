import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OwnerCover } from "../lib/recovery/cover-pay";

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[] }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => {
  const index = hooks.cursor++;
  if (!(index in hooks.slots)) hooks.slots[index] = initial;
  return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = value; }];
} }));
import CoverPay from "../components/console/cover-pay";
import CoverPage from "../components/booking/cover-page";

const cover: OwnerCover = { planId: "plan", sessionId: "yoga", instructorId: "instructor-04", instructor: "Jordan Lee", original: "Maya Chen", class: "Yoga Flow", when: "Monday",
  status: "accepted", current: true, respondedBy: "instructor", fee: "42.00", path: "/i/token", payee: true, payout: undefined,
  rule: { perClass: "30.00", perAttendee: "2.00", cap: "50.00" }, attendees: 6, estimate: true };
const updated = vi.fn();
beforeEach(() => { hooks.cursor = 0; hooks.slots = []; updated.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });
function render(covers = [cover]) { hooks.cursor = 0; return CoverPay({ workspaceId: "workspace1", covers, onUpdated: updated }); }
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element as ReactElement<Record<string, unknown>>, ...elements(element.props.children)];
}
function click(tree: ReactNode, label: string) {
  const button = elements(tree).find((element) => element.type === "button" && element.props.children === label)!;
  (button.props.onClick as () => void)();
}
function change(field: number, value: string) {
  (elements(render()).filter((element) => element.type === "input")[field].props.onChange as (event: unknown) => void)({ target: { value } });
}
function submit() {
  (elements(render()).find((element) => element.type === "form")!.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() });
}

it("shows the rule and estimate, and opens labelled inputs with keyboard-native form actions", () => {
  const tree = render();
  expect(renderToStaticMarkup(tree)).toContain("$30 per class + $2 per attendee, up to $50 · 6 booked → $42.00");
  expect(renderToStaticMarkup(tree)).toContain("Estimate — final after the class");
  click(tree, "Pay rule");
  const html = renderToStaticMarkup(render());
  expect(html).toContain('aria-expanded="true"'); expect(html).toContain('aria-label="Pay rule for Jordan Lee"');
  for (const label of ["Per class", "Per attendee (optional)", "Cap (optional)"]) expect(html).toContain(`<label>${label}<input`);
  expect(html).toContain('type="submit"'); expect(html).toContain('step="0.01"');
  click(render(), "Cancel"); expect(renderToStaticMarkup(render())).not.toContain("<form");
});

it("PATCHes amounts and omitted optional fields, then announces success and refreshes", async () => {
  const fetch = vi.fn(async () => Response.json([])); vi.stubGlobal("fetch", fetch);
  click(render(), "Pay rule"); change(0, "31.25"); change(1, ""); change(2, ""); submit();
  expect(elements(render()).filter((element) => element.type === "input").every((element) => element.props.disabled)).toBe(true);
  await vi.waitFor(() => { expect(updated).toHaveBeenCalledOnce(); });
  expect(fetch).toHaveBeenCalledWith("/api/workspaces/workspace1/instructors/instructor-04/pay", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ perClass: "31.25" }) }));
  const html = renderToStaticMarkup(render());
  expect(html).toContain('role="status"'); expect(html).toContain("Updated Jordan Lee"); expect(html).not.toContain("<form");
});

it("keeps server errors inline and allows resetting to the studio default", async () => {
  const fetch = vi.fn(async () => Response.json({ error: "Cap must be at least the per-class amount" }, { status: 400 })); vi.stubGlobal("fetch", fetch);
  click(render(), "Pay rule"); submit();
  await vi.waitFor(() => { expect(hooks.slots[0]).toBe(""); });
  expect(renderToStaticMarkup(render())).toContain('role="status">Cap must be at least the per-class amount');
  expect(updated).not.toHaveBeenCalled();
  fetch.mockImplementation(async () => Response.json([]));
  click(render(), "Use studio default"); await vi.waitFor(() => { expect(updated).toHaveBeenCalledOnce(); });
  expect(fetch).toHaveBeenLastCalledWith("/api/workspaces/workspace1/instructors/instructor-04/pay", expect.objectContaining({ method: "PATCH", body: '{"reset":true}' }));
});

it.each(["REQUESTED", "PENDING", "SUCCESS"] as const)("hides the editor and estimate for a %s payout", (status) => {
  const html = renderToStaticMarkup(render([{ ...cover, estimate: false, payout: { status, amount: "42.00", itemId: undefined, error: undefined } }]));
  expect(html).not.toContain(">Pay rule</button>"); expect(html).not.toContain("Estimate");
});

it("shows the instructor the fee, attendee breakdown and estimate on one line", () => {
  hooks.slots = [{ studio: { name: "Studio", timezone: "UTC" }, status: "asked", fee: "42.00", instructor: "Jordan Lee", original: "Maya Chen",
    rule: cover.rule, attendees: 6, estimate: true, canRespond: true, class: { title: "Yoga Flow", start: "2026-11-09T12:00:00Z", end: "2026-11-09T13:00:00Z", room: "Mat Studio" } }, "", false];
  const html = renderToStaticMarkup(<CoverPage token="private" />);
  expect(html).toContain("Cover fee $42.00");
  expect(html).toContain("$30 per class + $2 per attendee, up to $50 · 6 booked · Estimate — final after the class");
});
