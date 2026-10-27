import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import type { CardSession, PayPalV6 } from "../lib/client/paypal-v6";

// Exercise the component's hook/effect lifecycle without adding a DOM or React
// test-renderer dependency. The SDK supplies fake hosted elements below; these
// tests do not simulate PayPal's cross-origin iframes or browser layout.
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], pending: [] as (() => void)[], cleanups: new Map<number, (() => void) | void>() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const changed = (previous: unknown[] | undefined, next: unknown[]) => !previous || next.length !== previous.length || next.some((value, index) => !Object.is(value, previous[index]));
  return {
    ...actual,
    useRef: (value: unknown) => {
      const index = hooks.cursor++;
      return hooks.slots[index] ??= { current: value };
    },
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value; }];
    },
    useCallback: (callback: unknown, dependencies: unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.slots[index] as { callback: unknown; dependencies: unknown[] } | undefined;
      if (changed(previous?.dependencies, dependencies)) hooks.slots[index] = { callback, dependencies };
      return (hooks.slots[index] as { callback: unknown }).callback;
    },
    useEffect: (effect: () => (() => void) | void, dependencies: unknown[]) => {
      const index = hooks.cursor++;
      if (changed(hooks.slots[index] as unknown[] | undefined, dependencies)) {
        hooks.slots[index] = dependencies;
        hooks.pending.push(() => { hooks.cleanups.get(index)?.(); hooks.cleanups.set(index, effect()); });
      }
    },
  };
});
vi.mock("next/script", () => ({ default: "sdk-script" }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/lib/client/paypal-v6", () => import("../lib/client/paypal-v6"));
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
  if (!element) throw new Error("Expected rendered element was not found");
  return element;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type Props = ComponentProps<typeof Payments>;
let props: Props;
let tree: ReactNode;
let card: CardSession;
let sdk: PayPalV6;
let createInstance: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let fields: { remove: ReturnType<typeof vi.fn> }[];
let root: { querySelector: ReturnType<typeof vi.fn> };

function render() {
  hooks.cursor = 0;
  tree = Payments(props);
  (tree as ReactElement<{ ref: { current: unknown } }>).props.ref.current = root;
  hooks.pending.splice(0).forEach((effect) => effect());
}
async function settle() {
  // Flush promises and resulting state updates, including create -> submit -> capture.
  for (let index = 0; index < 30; index++) { await Promise.resolve(); render(); }
}
async function load() {
  render();
  (find(tree, (element) => element.type === "sdk-script").props.onReady as () => void)();
  await settle();
}

it("loads only the sandbox JS SDK even if a caller supplies a non-sandbox presentation flag", () => {
  props = { ...props, sandbox: false };
  render();
  expect(find(tree, (element) => element.type === "sdk-script").props.src).toBe("https://www.sandbox.paypal.com/web-sdk/v6/core");
});
function clickPay() {
  (find(tree, (element) => element.type === "button" && element.props.className === "primary full-width").props.onClick as () => void)();
}
function alert() { return find(tree, (element) => element.props.role === "alert").props.children; }
const base = "/api/workspaces/studio/checkout/orders";
const receipt = { orderId: "ORDER-1", captureId: "CAPTURE-1", status: "confirmed" };

beforeEach(() => {
  hooks.cursor = 0; hooks.slots = []; hooks.pending = []; hooks.cleanups.clear();
  props = {
    id: "studio", session: { id: "class-1", classType: "pilates", title: "Pilates Flow", start: "2026-11-09T17:30:00Z", end: "2026-11-09T18:30:00Z", instructorId: "teacher", roomId: "room", capacity: 10, price: "18.00", seatsLeft: 1, instructor: "Teacher", room: "Studio" },
    customer: { name: "Jamie", email: "jamie@example.com" }, validate: () => true,
    clientId: "sandbox-client", sandbox: true, onSuccess: vi.fn(), onLockChange: vi.fn(),
  };
  fields = [];
  root = { querySelector: vi.fn(() => ({ hidden: true, appendChild: vi.fn() })) };
  card = {
    createCardFieldsComponent: vi.fn(() => {
      const field = { remove: vi.fn() }; fields.push(field);
      return field as unknown as HTMLElement;
    }),
    submit: vi.fn(async () => ({ state: "succeeded" as const, data: { orderId: "ORDER-1" } })),
  };
  sdk = {
    findEligibleMethods: vi.fn(async () => ({ isEligible: (method: string) => method === "advanced_cards", getDetails: () => ({}) })),
    createCardFieldsOneTimePaymentSession: vi.fn(() => card),
    createPayPalOneTimePaymentSession: vi.fn(), createPayLaterOneTimePaymentSession: vi.fn(),
  };
  createInstance = vi.fn(async () => sdk);
  vi.stubGlobal("window", { paypal: { createInstance } });
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url === base && init.method === "POST") return Response.json({ orderId: "ORDER-1" });
    if (url === `${base}/ORDER-1/capture` && init.method === "POST") return Response.json(receipt);
    if (url === `${base}/ORDER-1` && init.method === "DELETE") return Response.json({ cancelled: true });
    throw new Error(`Unexpected checkout request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  hooks.cleanups.forEach((cleanup) => cleanup?.());
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("card checkout lifecycle", () => {
  it("retains the SDK, session and typed fields through parent/catalog and customer re-renders, using the latest callbacks", async () => {
    await load();
    const originalFields = [...fields];
    // The parent receives a new catalog/session object and creates new callbacks.
    props = { ...props, session: { ...props.session, seatsLeft: 2 }, customer: { name: "New buyer", email: "buyer@example.com" }, validate: vi.fn(() => true), onSuccess: vi.fn(), onLockChange: vi.fn() };
    render(); await settle();
    expect(createInstance).toHaveBeenCalledTimes(1);
    expect(sdk.createCardFieldsOneTimePaymentSession).toHaveBeenCalledTimes(1);
    expect(card.createCardFieldsComponent).toHaveBeenCalledTimes(3);
    expect(fields).toEqual(originalFields);
    originalFields.forEach((field) => expect(field.remove).not.toHaveBeenCalled());
    clickPay(); await settle();
    expect(fetchMock).toHaveBeenCalledWith(base, expect.objectContaining({ body: JSON.stringify({ sessionId: "class-1", customer: props.customer }) }));
    expect(card.submit).toHaveBeenCalledWith("ORDER-1");
    expect(fetchMock).toHaveBeenCalledWith(`${base}/ORDER-1/capture`, expect.objectContaining({ method: "POST" }));
    expect(props.onSuccess).toHaveBeenCalledWith(receipt);
    expect(props.onLockChange).toHaveBeenCalledWith(true);
    expect(find(tree, (element) => element.type === "button" && element.props.className === "primary full-width").props.disabled).toBe(false);
  });

  it("preserves fields if the selected class price is refreshed", async () => {
    await load();
    props = { ...props, session: { ...props.session, price: "20.00" } };
    render(); await settle();
    expect(createInstance).toHaveBeenCalledTimes(1);
    expect(sdk.createCardFieldsOneTimePaymentSession).toHaveBeenCalledTimes(1);
    fields.forEach((field) => expect(field.remove).not.toHaveBeenCalled());
  });

  it("removes the hosted fields only on unmount", async () => {
    await load();
    hooks.cleanups.forEach((cleanup) => cleanup?.());
    expect(fields).toHaveLength(3);
    fields.forEach((field) => expect(field.remove).toHaveBeenCalledTimes(1));
  });

  it("ignores a pending setup after unmount", async () => {
    const pending = deferred<PayPalV6>();
    createInstance.mockReturnValue(pending.promise);
    await load();
    hooks.cleanups.forEach((cleanup) => cleanup?.());
    pending.resolve(sdk); await settle();
    expect(sdk.createCardFieldsOneTimePaymentSession).not.toHaveBeenCalled();
  });

  it("shows why customer validation prevents payment, using the latest validator", async () => {
    await load();
    props = { ...props, validate: () => false }; render();
    clickPay(); await settle();
    expect(alert()).toBe("Please enter your name and a valid email.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows why payment cannot start while card fields are loading", async () => {
    render(); clickPay(); await settle();
    expect(alert()).toBe("Card fields still loading. Please wait and try again.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an in-flight payment and prevents a duplicate create/submit/capture", async () => {
    const pending = deferred<Awaited<ReturnType<CardSession["submit"]>>>();
    vi.mocked(card.submit).mockReturnValue(pending.promise);
    await load(); clickPay(); await settle();
    clickPay(); await settle();
    expect(alert()).toBe("Payment already in progress.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(card.submit).toHaveBeenCalledTimes(1);
    pending.resolve({ state: "succeeded", data: { orderId: "ORDER-1" } }); await settle();
    expect(props.onSuccess).toHaveBeenCalledWith(receipt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("displays the SDK's incomplete-card validation message and releases busy state for a retry", async () => {
    vi.mocked(card.submit).mockResolvedValueOnce({ state: "failed", data: { orderId: "ORDER-1", message: "Card details incomplete" } });
    await load(); clickPay(); await settle();
    expect(alert()).toBe("Card details incomplete");
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/capture"))).toBe(false);
    expect(props.onLockChange).toHaveBeenLastCalledWith(false);
    clickPay(); await settle();
    expect(props.onSuccess).toHaveBeenCalledWith(receipt);
  });

  it("reports SDK rejection and allows another attempt", async () => {
    vi.mocked(card.submit).mockRejectedValueOnce(new Error("Card details incomplete"));
    await load(); clickPay(); await settle();
    expect(alert()).toBe("Card details incomplete");
    clickPay(); await settle();
    expect(card.submit).toHaveBeenCalledTimes(2);
    expect(props.onSuccess).toHaveBeenCalledWith(receipt);
  });

  it("requires capture reconciliation before another card submission", async () => {
    await load();
    fetchMock.mockImplementation(async (url: string) => url.endsWith("/capture")
      ? Response.json({ error: "Unknown capture outcome" }, { status: 503 })
      : Response.json({ orderId: "ORDER-1" }));
    clickPay(); await settle();
    expect(alert()).toBe("Unknown capture outcome");
    clickPay(); await settle();
    expect(alert()).toBe("Check payment status before trying again.");
    expect(card.submit).toHaveBeenCalledTimes(1);
  });
});

it("renders singular seats and HIIT titles in the booking catalog", async () => {
  fetchMock.mockResolvedValue(Response.json({ studio: { name: "Studio", timezone: "UTC" }, sessions: [{ ...props.session, title: "Hiit Flow" }] }));
  const renderPage = () => {
    hooks.cursor = 0;
    tree = BookingPage({ id: "studio", clientId: "sandbox-client", sandbox: true });
    hooks.pending.splice(0).forEach((effect) => effect());
  };
  renderPage();
  for (let index = 0; index < 10; index++) { await Promise.resolve(); renderPage(); }
  const text = elements(tree).flatMap((element) => typeof element.props.children === "string" ? [element.props.children] : []);
  expect(text).toContain("HIIT Flow");
  expect(text).toContain("1 seat left");
});
