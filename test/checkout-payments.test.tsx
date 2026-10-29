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
import BookingPage, { CreditPayment, Payments } from "../components/booking/booking-page";

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

it("pays with studio credit using only a POST body and reuses the key after a lost response", async () => {
  const creditProps = { id: "studio", token: "c".repeat(43), remaining: "22.00", session: props.session, customer: props.customer,
    validate: props.validate, onSuccess: vi.fn(), onLockChange: vi.fn() };
  const renderCredit = () => { hooks.cursor = 0; tree = CreditPayment(creditProps); };
  fetchMock.mockRejectedValueOnce(new Error("Response lost"))
    .mockResolvedValueOnce(Response.json({ error: "Workspace is busy; retry shortly" }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ ...receipt, orderId: undefined, captureId: undefined, paidWith: "credit" }));
  renderCredit();
  expect(elements(tree).some((element) => element.type === "sdk-script")).toBe(false);
  expect(elements(tree).some((element) => String(element.props.children).includes("PayPal"))).toBe(false);
  const click = () => (find(tree, (element) => element.type === "button").props.onClick as () => void)();
  click();
  for (let index = 0; index < 15; index++) { await Promise.resolve(); renderCredit(); }
  click();
  for (let index = 0; index < 15; index++) { await Promise.resolve(); renderCredit(); }
  click();
  for (let index = 0; index < 15; index++) { await Promise.resolve(); renderCredit(); }
  expect(fetchMock).toHaveBeenCalledTimes(3);
  const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
  expect(calls[0][0]).toBe("/api/bookings/studio/checkout/credit"); expect(calls[0][0]).not.toContain(creditProps.token);
  expect(calls[0][1]).toMatchObject({ method: "POST", referrerPolicy: "no-referrer" });
  expect(JSON.parse(calls[0][1].body as string)).toEqual({ creditToken: creditProps.token, sessionId: props.session.id, customer: props.customer });
  expect(calls[1][1].headers).toEqual(calls[0][1].headers);
  expect(calls[2][1].headers).toEqual(calls[0][1].headers);
  expect(creditProps.onSuccess).toHaveBeenCalledWith(expect.objectContaining({ paidWith: "credit" }));
});

it("shows insufficient studio credit without a payment button or PayPal", () => {
  tree = CreditPayment({ id: "studio", token: "c".repeat(43), remaining: "12.00", session: props.session, customer: props.customer,
    validate: props.validate, onSuccess: vi.fn(), onLockChange: vi.fn() });
  expect(elements(tree).some((element) => element.type === "button" || element.type === Payments)).toBe(false);
  expect(elements(tree).some((element) => element.type === "p" && String(element.props.children).includes("12.00"))).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("reads the credit token from the fragment, which never reaches a server, and removes it", async () => {
  const token = "f".repeat(43), replaceState = vi.fn();
  vi.stubGlobal("window", { location: { href: `http://localhost/b/studio?view=week#credit=${token}` }, history: { state: { page: "booking" }, replaceState } });
  fetchMock.mockImplementation(async (url: string) => Response.json(url.endsWith("/credit") ? { amount: "22.00", remaining: "22.00", status: "available" }
    : { studio: { name: "Studio", timezone: "UTC" }, sessions: [props.session] }));
  hooks.cursor = 0; tree = BookingPage({ id: "studio", clientId: "sandbox-client", sandbox: true }); hooks.pending.splice(0).forEach((effect) => effect());
  expect(replaceState).toHaveBeenCalledWith({ page: "booking" }, "", "/b/studio?view=week");
  await Promise.resolve();
  const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
  expect(calls.every(([url]) => !url.includes(token))).toBe(true);
  expect(calls.find(([url]) => url.endsWith("/credit"))?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ creditToken: token }) });
});

it("strips the URL credit token before requests and uses the credit payment option", async () => {
  const token = "c".repeat(43), replaceState = vi.fn();
  vi.stubGlobal("window", { location: { href: `http://localhost/b/studio?credit=${token}&view=week#classes` }, history: { state: { page: "booking" }, replaceState } });
  fetchMock.mockImplementation(async (url: string) => Response.json(url.endsWith("/credit") ? { amount: "22.00", remaining: "22.00", status: "available" }
    : { studio: { name: "Studio", timezone: "UTC" }, sessions: [props.session] }));
  const renderPage = () => { hooks.cursor = 0; tree = BookingPage({ id: "studio", clientId: "sandbox-client", sandbox: true }); hooks.pending.splice(0).forEach((effect) => effect()); };
  renderPage();
  expect(replaceState).toHaveBeenCalledWith({ page: "booking" }, "", "/b/studio?view=week#classes");
  for (let index = 0; index < 15; index++) { await Promise.resolve(); renderPage(); }
  const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
  expect(calls.every(([url]) => !url.includes(token))).toBe(true);
  expect(calls.find(([url]) => url.endsWith("/credit"))?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ creditToken: token }) });
  (find(tree, (element) => element.type === "button" && String(element.props.className).startsWith("bookable-class")).props.onClick as () => void)(); renderPage();
  expect(elements(tree).some((element) => element.type === CreditPayment)).toBe(true);
  expect(elements(tree).some((element) => element.type === Payments)).toBe(false);
});

it("labels credit receipts without a PayPal capture reference", () => {
  hooks.slots[0] = { studio: { name: "Studio", timezone: "UTC" }, sessions: [] };
  hooks.slots[4] = { bookingId: "credit-booking", paidWith: "credit", class: "Yoga", start: "2026-11-09T17:15:00Z", end: "2026-11-09T18:15:00Z", amount: "22.00", currency: "USD" };
  tree = BookingPage({ id: "studio", clientId: "sandbox-client", sandbox: true });
  expect(elements(tree).some((element) => element.type === "p" && Array.isArray(element.props.children) && element.props.children.includes("with studio credit"))).toBe(true);
  expect(elements(tree).some((element) => element.props.className === "capture-reference")).toBe(false);
});
function clickPay() {
  (find(tree, (element) => element.type === "button" && element.props.className === "primary full-width").props.onClick as () => void)();
}
function alert() { return find(tree, (element) => element.props.role === "alert").props.children; }
const base = "/api/bookings/studio/checkout/orders";
const receipt = { orderId: "ORDER-1", captureId: "CAPTURE-1", status: "confirmed" };

beforeEach(() => {
  hooks.cursor = 0; hooks.slots = []; hooks.pending = []; hooks.cleanups.clear();
  props = {
    id: "studio", session: { id: "class-1", classType: "pilates", title: "Pilates Flow", start: "2026-11-09T17:30:00Z", end: "2026-11-09T18:30:00Z", capacity: 10, price: "18.00", seatsLeft: 1, bookingPaused: false, instructor: "Teacher", room: "Studio" },
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
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("card checkout lifecycle", () => {
  it("sends the latest availability with order creation without reinitializing hosted fields", async () => {
    await load();
    props = { ...props, availability: { times: ["evenings"], days: ["weekdays"], acceptsSubstitute: false } };
    render(); await settle(); clickPay(); await settle();
    expect(fetchMock).toHaveBeenCalledWith(base, expect.objectContaining({ body: JSON.stringify({ sessionId: props.session.id, customer: props.customer, availability: props.availability }) }));
    expect(createInstance).toHaveBeenCalledTimes(1); expect(props.onSuccess).toHaveBeenCalledWith(receipt);
  });
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

  it("allows approval or cancellation after PayPal rejects an unapproved capture", async () => {
    await load();
    fetchMock.mockResolvedValueOnce(Response.json({ orderId: "ORDER-1" })).mockResolvedValueOnce(Response.json({
      error: "PayPal hasn't approved this payment yet. Approve it in PayPal or choose another method.", code: "ORDER_NOT_APPROVED",
    }, { status: 422 }));
    clickPay(); await settle();
    expect(alert()).toContain("Approve it in PayPal");
    expect(elements(tree).some((element) => element.props.children === "Check payment status")).toBe(false);
    expect(elements(tree).some((element) => element.props.children === "Cancel checkout")).toBe(true);
    clickPay(); await settle();
    expect(card.submit).toHaveBeenCalledTimes(2);
    expect(props.onSuccess).toHaveBeenCalledWith(receipt);
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

it("offers collapsed optional availability, passes checkbox answers to Payments and locks the fieldset during checkout", () => {
  hooks.slots[0] = { studio: { name: "Studio", timezone: "UTC" }, sessions: [props.session] };
  hooks.slots[1] = props.session;
  const renderPage = () => { hooks.cursor = 0; tree = BookingPage({ id: "studio", clientId: "sandbox-client", sandbox: true }); };
  const checkbox = (name: string, value?: string) => find(tree, (element) => element.type === "input" && element.props.name === name && (value === undefined || element.props.value === value));
  const change = (name: string, value: string | undefined, checked: boolean) => {
    (checkbox(name, value).props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked } }); renderPage();
  };
  renderPage();
  expect(find(tree, (element) => element.type === "details").props.open).toBeUndefined();
  expect(find(tree, (element) => element.type === "summary").props.children).toBe("If this class has to move, when can you usually come?");
  expect(find(tree, (element) => element.type === "legend").props.children).toBe("Usual availability (optional)");
  expect(elements(tree).filter((element) => element.type === "input" && element.props.type === "checkbox")).toHaveLength(6);
  expect(checkbox("acceptsSubstitute").props.checked).toBe(true);
  expect(find(tree, (element) => element.type === Payments).props.availability).toBeUndefined();
  change("times", "mornings", true); change("times", "evenings", true); change("times", "mornings", false);
  change("days", "weekdays", true); change("days", "weekends", true); change("days", "weekends", false);
  change("acceptsSubstitute", undefined, false);
  let payment = find(tree, (element) => element.type === Payments);
  expect(payment.props.availability).toEqual({ times: ["evenings"], days: ["weekdays"], acceptsSubstitute: false });
  (payment.props.onLockChange as (locked: boolean) => void)(true); renderPage();
  expect(find(tree, (element) => element.type === "fieldset").props.disabled).toBe(true);
  expect(elements(tree).filter((element) => element.type === "input" && element.props.readOnly === true)).toHaveLength(2);
  payment = find(tree, (element) => element.type === Payments);
  (payment.props.onLockChange as (locked: boolean) => void)(false); renderPage();
  expect(find(tree, (element) => element.type === "fieldset").props.disabled).toBe(false);
  change("times", "evenings", false); change("days", "weekdays", false);
  expect(find(tree, (element) => element.type === Payments).props.availability).toEqual({ times: undefined, days: undefined, acceptsSubstitute: false });
  hooks.pending = [];
});

it("never links a public checkout receipt to the owner console", () => {
  hooks.slots[0] = { studio: { name: "Studio", timezone: "UTC" }, sessions: [] };
  hooks.slots[4] = { ...receipt, class: "Yoga", start: "2026-11-09T17:30:00Z", end: "2026-11-09T18:30:00Z", amount: "22.00", currency: "USD" };
  tree = BookingPage({ id: "0123456789abcdefghijklmnopqrstuv", clientId: "sandbox-client", sandbox: true });
  expect(elements(tree).some((element) => element.props.children === "Booking confirmed")).toBe(true);
  expect(elements(tree).filter((element) => typeof element.props.href === "string").map((element) => element.props.href)).toEqual(["/"]);
});

it("refreshes a confirmed receipt every fifteen seconds and announces its updated time", async () => {
  vi.useFakeTimers();
  const original = { ...receipt, bookingId: "booking-1", class: "Dance Flow", start: "2026-11-09T17:15:00Z", end: "2026-11-09T18:15:00Z", amount: "22.00", currency: "USD", webhookConfigured: true, webhookConfirmed: true };
  const current = { class: "Dance Flow", start: "2026-11-10T17:15:00Z", end: "2026-11-10T18:15:00Z", status: "moved", changed: true };
  const catalog = { studio: { name: "Studio", timezone: "UTC" }, sessions: [] };
  hooks.slots[0] = catalog; hooks.slots[4] = original;
  fetchMock.mockImplementation(async (url: string) => Response.json(url.endsWith("/ORDER-1") ? { ...original, current } : catalog));
  const renderPage = () => {
    hooks.cursor = 0; tree = BookingPage({ id: "studio", clientId: "sandbox-client", sandbox: true });
    hooks.pending.splice(0).forEach((effect) => effect());
  };
  renderPage();
  await vi.advanceTimersByTimeAsync(14_999);
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/ORDER-1"))).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1); renderPage();
  const updated = "Updated: now Tue, Nov 10, 05:15 PM";
  expect(elements(tree).some((element) => element.props.children === updated)).toBe(true);
  expect(find(tree, (element) => element.props["aria-live"] === "polite").props.children).toContain(updated);
  const originalTime = find(tree, (element) => element.type === "p" && element.props.className === "muted" && Array.isArray(element.props.children) && element.props.children[0] === "Originally: ");
  expect(originalTime.props.children).toContain("Mon, Nov 9, 05:15 PM");
  expect(elements(tree).some((element) => element.props.children === "Add to calendar")).toBe(true);
  await vi.advanceTimersByTimeAsync(15_000); renderPage();
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/ORDER-1"))).toHaveLength(2);
});

it.each(["refunded", "refund_pending", "cancelled"])("shows %s accurately and hides the calendar download", (status) => {
  hooks.slots[0] = { studio: { name: "Studio", timezone: "UTC" }, sessions: [] };
  hooks.slots[4] = { ...receipt, class: "Dance Flow", start: "2026-11-09T17:15:00Z", end: "2026-11-09T18:15:00Z", amount: "22.00", currency: "USD",
    current: { class: "Dance Flow", start: "2026-11-10T17:15:00Z", end: "2026-11-10T18:15:00Z", status, changed: true } };
  tree = BookingPage({ id: "studio", clientId: "sandbox-client", sandbox: true });
  expect(elements(tree).some((element) => element.props.children === "Add to calendar")).toBe(false);
  const statusText = status === "refunded" ? "Refunded" : status === "refund_pending" ? "Refund pending" : "Cancelled";
  expect(find(tree, (element) => element.props["aria-live"] === "polite").props.children).toContain(statusText);
  expect(elements(tree).some((element) => element.props.children === statusText)).toBe(true);
});

it("shows paused classes disabled, then allows selection when a refreshed catalog resumes bookings", async () => {
  vi.useFakeTimers();
  let bookingPaused = true;
  fetchMock.mockImplementation(async () => Response.json({ studio: { name: "Studio", timezone: "UTC" }, sessions: [{ ...props.session, bookingPaused }] }));
  const renderPage = () => {
    hooks.cursor = 0; tree = BookingPage({ id: "studio", clientId: "sandbox-client", sandbox: true });
    hooks.pending.splice(0).forEach((effect) => effect());
  };
  const flush = async () => { for (let index = 0; index < 10; index++) { await Promise.resolve(); renderPage(); } };
  const classButton = () => find(tree, (element) => element.type === "button" && String(element.props.className).startsWith("bookable-class"));
  renderPage(); await flush();
  expect(classButton().props.disabled).toBe(true);
  expect(elements(tree).some((element) => element.props.children === "Schedule change in progress — booking paused")).toBe(true);
  expect(() => (classButton().props.onClick as () => void)()).toThrow("Checkout is unavailable");
  bookingPaused = false;
  await vi.advanceTimersByTimeAsync(15_000); await flush();
  expect(classButton().props.disabled).toBe(false);
  (classButton().props.onClick as () => void)(); renderPage();
  expect(elements(tree).some((element) => element.type === Payments)).toBe(true);
});
