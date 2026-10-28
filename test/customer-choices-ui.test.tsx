import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import type { CustomerChoiceView } from "../lib/choices/service";
import type { WebMcpTool } from "../lib/webmcp/bridge";

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], pending: [] as (() => void)[], cleanups: new Map<number, (() => void) | void>(), tools: [] as WebMcpTool[] }));
vi.mock("../lib/webmcp/use-webmcp", () => ({ useWebMcp: (tools: WebMcpTool[] | (() => WebMcpTool[])) => { hooks.tools = typeof tools === "function" ? tools() : tools; } }));
// Follow the checkout component tests: exercise request/effect behavior without a DOM dependency.
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const changed = (before: unknown[] | undefined, next: unknown[]) => !before || next.some((value, index) => !Object.is(value, before[index]));
  return { ...actual,
    useRef: (value: unknown) => { const index = hooks.cursor++; return hooks.slots[index] ??= { current: value }; },
    useState: (value: unknown) => {
      const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = value;
      return [hooks.slots[index], (next: unknown) => { hooks.slots[index] = next; }];
    },
    useCallback: (callback: unknown, dependencies: unknown[]) => {
      const index = hooks.cursor++; const previous = hooks.slots[index] as { callback: unknown; dependencies: unknown[] } | undefined;
      if (changed(previous?.dependencies, dependencies)) hooks.slots[index] = { callback, dependencies };
      return (hooks.slots[index] as { callback: unknown }).callback;
    },
    useEffect: (effect: () => (() => void) | void, dependencies: unknown[]) => {
      const index = hooks.cursor++;
      if (changed(hooks.slots[index] as unknown[] | undefined, dependencies)) {
        hooks.slots[index] = dependencies; hooks.pending.push(() => { hooks.cleanups.get(index)?.(); hooks.cleanups.set(index, effect()); });
      }
    },
  };
});
import CustomerChoicePage from "../components/booking/customer-choice-page";
import MessagesDrawer from "../components/console/messages-drawer";

type Element = ReactElement<Record<string, unknown>>;
let tree: ReactNode, data: CustomerChoiceView, send: ReturnType<typeof vi.fn>;
let focusHeading: ReturnType<typeof vi.fn<(heading: string) => void>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...elements(element.props.children as ReactNode)];
}
function render() {
  hooks.cursor = 0; tree = CustomerChoicePage({ token: "a".repeat(43) });
  for (const element of elements(tree)) {
    if (element.type === "h2" && element.props.ref) (element.props.ref as { current: unknown }).current = { focus: () => focusHeading(renderToStaticMarkup(element)) };
  }
  hooks.pending.splice(0).forEach((effect) => effect());
}
async function settle() { for (let index = 0; index < 20; index++) { await Promise.resolve(); render(); } }
function button(label: string) { return elements(tree).find((element) => element.type === "button" && renderToStaticMarkup(element).includes(label))!; }
beforeEach(() => {
  vi.useFakeTimers(); hooks.cursor = 0; hooks.slots = []; hooks.pending = []; hooks.cleanups.clear();
  focusHeading = vi.fn();
  const session = { id: "current", classType: "yoga" as const, title: "Yoga Flow", start: "2026-11-10T15:00:00Z", end: "2026-11-10T16:00:00Z", instructorId: "teacher", roomId: "room", instructor: "Alex Rivera", price: "22.00", capacity: 10 };
  data = { studio: { name: "Northstar", timezone: "America/New_York" }, before: { ...session, start: "2026-11-09T15:00:00Z", instructor: "Maya Chen" }, after: session,
    message: { subject: "Your class changed", body: "Hi Avery,\n\nA new time for your class." }, kind: "choice", canChoose: true, choicesClosed: false, expiresAt: Date.now() + 60_000,
    simulated: false, refundable: "22.00", receipt: undefined, reply: undefined,
    alternatives: [{ ...session, id: "other", title: "Gentle Yoga", seatsLeft: 1, difference: "4.00", price: "18.00" }] };
  send = vi.fn(async () => Response.json(data)); vi.stubGlobal("fetch", send);
});
afterEach(() => { for (const cleanup of hooks.cleanups.values()) cleanup?.(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("shows old/new class details, drafted message and three choices; offers the lower-price refund", async () => {
  render(); await settle();
  let html = renderToStaticMarkup(tree);
  expect(html).toContain("Maya Chen"); expect(html).toContain("Alex Rivera"); expect(html).toContain("Hi Avery");
  expect(html).toContain("Keep my new time"); expect(html).toContain("Pick another class"); expect(html).toContain("Refund me");
  (button("Pick another class").props.onClick as () => void)(); render();
  html = renderToStaticMarkup(tree); expect(html).toContain("Gentle Yoga"); expect(html).toContain("$4.00 refunded");
  (button("Gentle Yoga").props.onClick as () => void)(); await settle();
  const call = send.mock.calls.find((args: unknown[]) => (args[1] as RequestInit)?.method === "POST")! as unknown as [string, RequestInit];
  expect(call[0]).toBe(`/api/choices/${"a".repeat(43)}`); expect(JSON.parse(call[1].body as string)).toEqual({ action: "move", sessionId: "other" });
});

it("asks for a proposal, focuses it, and confirms only through the existing choice API", async () => {
  render(); await settle();
  const textarea = elements(tree).find((element) => element.type === "textarea")!;
  expect(textarea.props.maxLength).toBe(300);
  (textarea.props.onChange as (event: unknown) => void)({ target: { value: "Wednesday yoga" } }); render();
  let resolve!: (response: Response) => void;
  send.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
  (button("Ask").props.onClick as () => void)(); render();
  expect(renderToStaticMarkup(tree)).toContain("Checking this week’s classes…");
  resolve(Response.json({ action: "move", sessionId: "other", class: data.alternatives[0], refund: "4.00", reply: "This class fits.", checked: 29, source: "gemini", model: "test" })); await settle();
  const html = renderToStaticMarkup(tree);
  expect(html).toContain("Checked 29 classes"); expect(html).toContain("$4.00 back to your PayPal");
  expect(html).toContain("Keep my new time"); expect(html).toContain("Pick another class"); expect(html).toContain("Refund me");
  expect(focusHeading).toHaveBeenCalledOnce(); expect(focusHeading.mock.calls[0][0]).toContain("Gentle Yoga");
  expect(send.mock.calls.filter((args: unknown[]) => (args[1] as RequestInit)?.method === "POST")).toHaveLength(1);
  (button("Confirm").props.onClick as () => void)(); await settle();
  const posts = send.mock.calls.filter((args: unknown[]) => (args[1] as RequestInit)?.method === "POST") as unknown as [string, RequestInit][];
  expect(posts[0][0]).toBe(`/api/choices/${"a".repeat(43)}/assistant`); expect(JSON.parse(posts[0][1].body as string)).toEqual({ message: "Wednesday yoga" });
  expect(posts[1][0]).toBe(`/api/choices/${"a".repeat(43)}`); expect(JSON.parse(posts[1][1].body as string)).toEqual({ action: "move", sessionId: "other" });
});

it("shows a clarification question with the textarea and manual controls", async () => {
  render(); await settle();
  send.mockResolvedValueOnce(Response.json({ action: "clarify", refund: "0.00", reply: "Which day works for you?", checked: 29, source: "gemini", model: "test" }));
  await hooks.tools[0].execute({ message: "another class" }, { signal: new AbortController().signal }); await settle();
  const html = renderToStaticMarkup(tree);
  expect(html).toContain("Which day works for you?"); expect(html).toContain("textarea"); expect(html).toContain("Keep my new time"); expect(html).not.toContain(">Confirm<");
  expect(elements(tree).find((element) => element.type === "textarea")!.props.value).toBe("another class");
});

it("WebMCP displays a proposal without submitting a choice, and Not quite clears it", async () => {
  render(); await settle();
  expect(hooks.tools.map((tool) => tool.name)).toEqual(["ask_rebook_assistant"]);
  const proposal = { action: "keep", refund: "0.00", reply: "Keep this class?", checked: 29, source: "gemini", model: "test" };
  send.mockResolvedValueOnce(Response.json(proposal));
  expect(await hooks.tools[0].execute({ message: "keep" }, { signal: new AbortController().signal })).toEqual(proposal); await settle();
  expect(renderToStaticMarkup(tree)).toContain("Keep this class?");
  expect(send.mock.calls.filter((args: unknown[]) => (args[1] as RequestInit)?.method === "POST")).toHaveLength(1);
  (button("Not quite").props.onClick as () => void)(); render(); expect(renderToStaticMarkup(tree)).not.toContain("Keep this class?");
  data = { ...data, canChoose: false }; await vi.advanceTimersByTimeAsync(5000); await settle(); expect(hooks.tools).toEqual([]);
});

it("keeps manual choices available after assistant unavailability", async () => {
  render(); await settle();
  send.mockResolvedValueOnce(Response.json({ error: "The assistant is busy right now. You can still choose below." }, { status: 503 }));
  await expect(hooks.tools[0].execute({ message: "help" }, { signal: new AbortController().signal })).rejects.toThrow("busy"); await settle();
  expect(renderToStaticMarkup(tree)).toContain("The assistant is busy"); expect(button("Refund me").props.disabled).toBe(false);
});

it("suppresses double taps, shows pending status, then polls the receipt to completion", async () => {
  render(); await settle();
  expect(elements(tree).find((element) => element.type === "details")?.props.open).toBe(true);
  let resolve!: (response: Response) => void;
  send.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
  const click = button("Refund me").props.onClick as () => void; click(); click(); render();
  expect(button("Refund me").props.disabled).toBe(true);
  expect(send.mock.calls.filter((args: unknown[]) => (args[1] as RequestInit)?.method === "POST")).toHaveLength(1);
  data = { ...data, canChoose: false, reply: { action: "refund", at: new Date().toISOString() }, receipt: { amount: "22.00", status: "PENDING", paypalId: "7GD-DEMO", error: undefined } };
  resolve(Response.json(data)); await settle(); expect(renderToStaticMarkup(tree)).toContain("Refund pending");
  expect(renderToStaticMarkup(tree)).toContain("Original message from your studio");
  expect(elements(tree).find((element) => element.type === "details")?.props.open).toBe(false);
  data.receipt!.status = "COMPLETED"; await vi.advanceTimersByTimeAsync(5000); await settle();
  const html = renderToStaticMarkup(tree); expect(html).toContain("Refund completed"); expect(html).toContain("7GD-DEMO"); expect(html).not.toContain("Refund me");
  expect(elements(tree).find((element) => element.type === "details")?.props.open).toBe(false);
  for (const cleanup of hooks.cleanups.values()) cleanup?.();
  hooks.slots = []; hooks.cleanups.clear(); render(); await settle();
  expect(elements(tree).find((element) => element.type === "details")?.props.open).toBe(false);
  expect(renderToStaticMarkup(tree)).toContain("Original message from your studio");
});

it("focuses the result heading after a selected alternative disappears and does not refocus on polling", async () => {
  render(); await settle();
  (button("Pick another class").props.onClick as () => void)(); render();
  data = { ...data, reply: { action: "move", at: new Date().toISOString() }, after: data.alternatives[0] };
  (button("Gentle Yoga").props.onClick as () => void)(); await settle();
  expect(renderToStaticMarkup(tree)).not.toContain('class="choice-option"');
  expect(focusHeading).toHaveBeenCalledOnce();
  expect(focusHeading.mock.calls[0][0]).toContain('tabindex="-1">You’re all set.');
  await vi.advanceTimersByTimeAsync(5000); await settle();
  expect(focusHeading).toHaveBeenCalledOnce();
});

it("labels simulation and gives receipt-only customers no choice controls", async () => {
  data = { ...data, simulated: true, kind: "receipt", canChoose: false, receipt: { amount: "22.00", status: "SIMULATED", paypalId: "SIM-REFUND", error: undefined } };
  render(); await settle(); const html = renderToStaticMarkup(tree);
  expect(html).toContain("Simulated payment"); expect(html).toContain("Your refund receipt"); expect(html).not.toContain("Keep my new time");
});

it("shows a lasting outcome after class start and suppresses choice controls", async () => {
  data = { ...data, canChoose: false, choicesClosed: true, expiresAt: Date.now() - 60_000, reply: { action: "keep", at: new Date().toISOString() }, alternatives: [] };
  render(); await settle();
  const html = renderToStaticMarkup(tree);
  expect(html).toContain("You’re all set."); expect(html).toContain("Your new time is confirmed.");
  expect(html).not.toContain("Keep my new time"); expect(html).not.toContain("Refund me");
});

it("keeps the class update readable with a clear closed-choice message after the deadline", async () => {
  data = { ...data, canChoose: false, choicesClosed: true, expiresAt: Date.now() - 60_000, alternatives: [] };
  render(); await settle();
  const html = renderToStaticMarkup(tree);
  expect(html).toContain("Choices are closed. Your class update remains available here.");
  expect(html).toContain("Yoga Flow"); expect(html).not.toContain("Refund me");
});

it("removes stale choice controls when polling discovers an expired link", async () => {
  render(); await settle();
  send.mockResolvedValueOnce(Response.json({ error: "This private link has expired." }, { status: 410 }));
  await vi.advanceTimersByTimeAsync(5000); await settle();
  const html = renderToStaticMarkup(tree);
  expect(html).toContain("This private link has expired."); expect(html).not.toContain("Keep my new time");
});

it("includes demo customer links and copy controls in approved messages", () => {
  hooks.cursor = 0; hooks.slots = []; hooks.pending = [];
  const html = renderToStaticMarkup(MessagesDrawer({ messages: [{ bookingId: "booking", customerId: "customer", subject: "Your class", body: "Use your link below." }],
    links: [{ bookingId: "booking", planId: "plan", kind: "choice", path: "/c/private-token", expiresAt: Date.now() + 60_000 }], onClose: () => {} }));
  expect(html).toContain("Open as customer"); expect(html).toContain("Copy link"); expect(html).toContain("/c/private-token");
  expect(html).toContain("share each private link from your own app");
  expect(html).toMatch(/Demo addresses can(?:&#x27;|')t receive email\./);
});

it("labels receipt and choice cards and lists kept/moved choice links first", () => {
  hooks.cursor = 0; hooks.slots = []; hooks.pending = [];
  const messages = ["refunded", "kept", "moved"].map((bookingId) => ({ bookingId, customerId: "customer", subject: bookingId, body: "Class update" }));
  const drawer = MessagesDrawer({ messages, links: messages.map((message) => ({ bookingId: message.bookingId, planId: "plan",
    kind: message.bookingId === "refunded" ? "receipt" as const : "choice" as const, path: `/c/${message.bookingId}`, expiresAt: Date.now() + 60_000 })), onClose: () => {} });
  const cards = elements(drawer).filter((element) => element.type === "article").map((card) => renderToStaticMarkup(card));
  expect(cards).toHaveLength(3);
  expect(cards[0]).toContain("Private choice link"); expect(cards[0]).toContain("/c/kept");
  expect(cards[1]).toContain("Private choice link"); expect(cards[1]).toContain("/c/moved");
  expect(cards[2]).toContain("Refund receipt"); expect(cards[2]).toContain("/c/refunded");
});
