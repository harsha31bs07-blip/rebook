"use client";

import Script from "next/script";
import AgentConnect from "./agent-connect";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { bookingCatalog, CheckoutInput, Receipt, studioCredit } from "@/lib/checkout/service";
import { calendarFile, eligibleCheckoutMethods, payLaterButtonTag, type CardSession, type EligibleMethods, type PayPalV6 } from "@/lib/client/paypal-v6";
import AgentReadyChip from "../webmcp/agent-ready-chip";
import { useWebMcp } from "../../lib/webmcp/use-webmcp";
import { bookingTools } from "../../lib/webmcp/tools";
import { localParts } from "../../lib/domain/time";

type Catalog = ReturnType<typeof bookingCatalog>;
type Class = Catalog["sessions"][number];
class CheckoutError extends Error { constructor(message: string, public code: string | undefined, public status: number) { super(message); } }
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store", referrerPolicy: "no-referrer" });
  const body = await response.json();
  if (!response.ok) throw new CheckoutError(body.error ?? "Checkout could not be completed", body.code, response.status);
  return body;
}
function classTitle(title: string) { return title.replace(/\bhiit\b/gi, "HIIT"); }
export function CreditPayment({ id, token, remaining, session, customer, availability, validate, onSuccess, onLockChange }: {
  id: string; token: string; remaining: string; session: Class; customer: CheckoutInput["customer"]; availability?: CheckoutInput["availability"];
  validate(): boolean; onSuccess(receipt: Receipt): void; onLockChange(locked: boolean): void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const inFlight = useRef(false), key = useRef(""), uncertain = useRef(false);
  const sufficient = Math.round(Number(remaining) * 100) >= Math.round(Number(session.price) * 100);
  async function pay() {
    if (inFlight.current || !sufficient || !validate()) return;
    inFlight.current = true; setBusy(true); setError(""); onLockChange(true); key.current ||= crypto.randomUUID();
    try {
      onSuccess(await request<Receipt>(`/api/bookings/${id}/checkout/credit`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key.current },
        body: JSON.stringify({ creditToken: token, sessionId: session.id, customer, availability }) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Please try again.");
      // Unknown responses keep the same key and details so retry cannot spend twice.
      if (cause instanceof CheckoutError && cause.status < 500 && !uncertain.current) { key.current = ""; onLockChange(false); }
      else uncertain.current = true;
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <div className="payment-methods" aria-busy={busy}><h3>Pay with your studio credit (${remaining} left)</h3>
    {sufficient ? <button className="primary full-width" disabled={busy} onClick={() => void pay()}>{busy ? "Booking your class…" : "Book with studio credit"}</button>
      : <p>Your studio credit covers classes up to ${remaining}. Choose another class to use it.</p>}
    {error && <p className="error" role="alert">{error}</p>}</div>;
}
export function Payments({ id, session, customer, availability, waitlistToken, validate, clientId, sandbox, onSuccess, onLockChange }: {
  id: string; session: Class; customer: { name: string; email: string }; validate(): boolean;
  availability?: CheckoutInput["availability"]; waitlistToken?: string;
  clientId: string; sandbox: boolean; onSuccess(receipt: Receipt): void; onLockChange(locked: boolean): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<CardSession | undefined>(undefined);
  const current = useRef({ customer, availability, validate, onSuccess, onLockChange });
  useEffect(() => { current.current = { customer, availability, validate, onSuccess, onLockChange }; }, [customer, availability, validate, onSuccess, onLockChange]);
  useEffect(() => () => current.current.onLockChange(false), []);
  const order = useRef<{ orderId: string } | undefined>(undefined);
  const key = useRef("");
  const inFlight = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retryCapture, setRetryCapture] = useState(false);
  const [hasOrder, setHasOrder] = useState(false);
  const [methods, setMethods] = useState({ paypal: false, paylater: false, cards: false });
  // Payments is keyed by the selected class. Freeze SDK configuration for that
  // mount so catalog refreshes and edits never replace the buyer's hosted fields.
  const configuration = useRef({ clientId, price: session.price });
  const initialization = useRef<Promise<{ sdk: PayPalV6; eligible: EligibleMethods }> | undefined>(undefined);
  const base = `/api/bookings/${id}/checkout/orders`;

  const create = useCallback(async () => {
    if (!current.current.validate()) throw new Error("Please enter your name and a valid email.");
    current.current.onLockChange(true);
    key.current ||= crypto.randomUUID();
    try {
      order.current ??= await request<{ orderId: string }>(base, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key.current },
        body: JSON.stringify({ sessionId: session.id, customer: current.current.customer, availability: current.current.availability, waitlistToken }) });
      setHasOrder(true);
      return order.current;
    } catch (cause) {
      if (cause instanceof CheckoutError && cause.status >= 400 && cause.status < 500) {
        order.current = undefined; key.current = "";
        current.current.onLockChange(false);
      }
      throw cause;
    }
  }, [base, session.id, waitlistToken]);
  const cancel = useCallback(async () => {
    if (order.current) {
      try {
        const result = await request<{ receipt?: Receipt }>(`${base}/${order.current.orderId}`, { method: "DELETE" });
        if (result.receipt) { current.current.onSuccess(result.receipt); return; }
      } catch (cause) {
        if (cause instanceof CheckoutError && cause.code === "CHECK_PAYMENT_STATUS") setRetryCapture(true);
        throw cause;
      }
    }
    order.current = undefined; key.current = ""; setHasOrder(false);
    current.current.onLockChange(false);
  }, [base]);
  const capture = useCallback(async (orderId: string) => {
    try {
      const receipt = await request<Receipt>(`${base}/${orderId}/capture`, { method: "POST" });
      setRetryCapture(false); current.current.onSuccess(receipt);
    } catch (cause) {
      const unapproved = cause instanceof CheckoutError && ["ORDER_NOT_APPROVED", "PAYER_ACTION_REQUIRED"].includes(cause.code ?? "");
      const restart = cause instanceof CheckoutError && ["INSTRUMENT_DECLINED", "RESTART_CHECKOUT"].includes(cause.code ?? "");
      if (restart) { order.current = undefined; key.current = ""; setHasOrder(false); current.current.onLockChange(false); }
      setRetryCapture(!restart && !unapproved);
      throw cause;
    }
  }, [base]);
  const fail = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : "Payment could not be completed. Please try again."), []);
  const actions = useRef({ create, cancel, capture, fail });
  useEffect(() => { actions.current = { create, cancel, capture, fail }; }, [create, cancel, capture, fail]);

  useEffect(() => {
    if (!loaded || !configuration.current.clientId || !root.current) return;
    let disposed = false;
    const container = root.current;
    const cleanup: (() => void)[] = [];
    async function setup() {
      initialization.current ??= (async () => {
        const sdk = await window.paypal!.createInstance({ clientId: configuration.current.clientId, components: ["paypal-payments", "card-fields"], pageType: "checkout" });
        const eligible = await sdk.findEligibleMethods({ currencyCode: "USD", amount: configuration.current.price });
        return { sdk, eligible };
      })();
      const { sdk, eligible } = await initialization.current;
      if (disposed) return;
      const mapping = eligibleCheckoutMethods(eligible);
      setMethods(mapping);
      const callbacks = { onApprove: async ({ orderId }: { orderId: string }) => { try { await actions.current.capture(orderId); } catch (cause) { actions.current.fail(cause); throw cause; } },
        onCancel: () => { void actions.current.cancel().catch(actions.current.fail); }, onError: (cause: { message?: string }) => actions.current.fail(new Error(cause.message || "PayPal could not complete checkout.")) };
      for (const kind of ["paypal", "paylater"] as const) {
        if (!mapping[kind]) continue;
        const button = document.createElement(kind === "paypal" ? "paypal-button" : payLaterButtonTag(window.customElements));
        button.setAttribute("type", "pay");
        button.setAttribute("class", "paypal-gold");
        if (kind === "paylater") Object.assign(button, eligible.getDetails("paylater"));
        button.setAttribute("aria-label", kind === "paypal" ? "Pay with PayPal" : "Pay Later");
        const payment = kind === "paypal" ? sdk.createPayPalOneTimePaymentSession(callbacks) : sdk.createPayLaterOneTimePaymentSession(callbacks);
        const click = async () => {
          if (inFlight.current) { setError("Payment already in progress."); return; }
          if (!current.current.validate()) { setError("Please enter your name and a valid email."); return; }
          inFlight.current = true; setBusy(true); setError("");
          try { await payment.start({ presentationMode: "auto" }, actions.current.create()); }
          catch (cause) { actions.current.fail(cause); }
          finally { inFlight.current = false; setBusy(false); }
        };
        button.addEventListener("click", click);
        container.querySelector(".wallet-buttons")!.appendChild(button);
        cleanup.push(() => { button.removeEventListener("click", click); button.remove(); });
      }
      if (mapping.cards) {
        // Hosted fields measure their containers during mounting.
        container.querySelector<HTMLElement>(".card-checkout")!.hidden = false;
        card.current = sdk.createCardFieldsOneTimePaymentSession();
        for (const type of ["number", "expiry", "cvv"] as const) {
          const field = card.current.createCardFieldsComponent({ type, placeholder: type === "number" ? "Card number" : type === "expiry" ? "MM/YY" : "CVV", style: { input: { fontSize: "16px" } } });
          container.querySelector(`[data-card="${type}"]`)!.appendChild(field);
          cleanup.push(() => field.remove());
        }
      }
      setReady(true);
    }
    void setup().catch((cause) => { if (!disposed) actions.current.fail(cause); });
    return () => { disposed = true; cleanup.forEach((fn) => fn()); card.current = undefined; };
  }, [loaded]);

  async function payCard() {
    if (inFlight.current) { setError("Payment already in progress."); return; }
    if (!current.current.validate()) { setError("Please enter your name and a valid email."); return; }
    if (!card.current) { setError("Card fields still loading. Please wait and try again."); return; }
    if (retryCapture) { setError("Check payment status before trying again."); return; }
    inFlight.current = true; setBusy(true); setError("");
    try {
      const pending = await create();
      const result = await card.current.submit(pending.orderId);
      if (result.state === "succeeded") await capture(result.data.orderId);
      else { await cancel(); throw new Error(result.state === "canceled" ? "Card verification cancelled. You can try again." : result.data.message || "Card declined. Please try a different card."); }
    } catch (cause) { fail(cause); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <div ref={root} className="payment-methods" aria-busy={busy}>
    {clientId ? <Script async src="https://www.sandbox.paypal.com/web-sdk/v6/core" strategy="afterInteractive" onReady={() => setLoaded(true)} onError={() => setError("PayPal could not load. Refresh this page to try again.")} /> : <p className="error">PayPal checkout is not configured for this studio.</p>}
    <h3>Pay with</h3>
    <div className="wallet-buttons" inert={busy || retryCapture} />
    {!ready && clientId && !error && <p role="status" className="muted">Checking available payment methods…</p>}
    {ready && !Object.values(methods).some(Boolean) && <p>No payment methods are available for this account.</p>}
    <div hidden={!methods.cards} className="card-checkout">
      <h3>Debit or credit card</h3>
      {sandbox && <p className="sandbox-card-hint"><strong>Sandbox test card</strong><br />4111 1111 1111 1111 · Any future expiry · Any CVV<br />No PayPal login needed. No real money is charged.</p>}
      <label>Card number<div data-card="number" className="paypal-card-field" /></label>
      <div className="card-row"><label>Expiry<div data-card="expiry" className="paypal-card-field" /></label><label>CVV<div data-card="cvv" className="paypal-card-field" /></label></div>
      <button className="primary full-width" disabled={busy || !ready || retryCapture} onClick={() => void payCard()}>{busy ? "Processing payment…" : `Pay $${session.price}`}</button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {retryCapture && <button disabled={busy} onClick={async () => { if (!order.current) { setError("No payment is available to check. Please start checkout again."); return; } setBusy(true); try { await capture(order.current.orderId); } catch (cause) { fail(cause); } finally { setBusy(false); } }}>Check payment status</button>}
    {hasOrder && !retryCapture && <button disabled={busy} onClick={() => void cancel().catch(fail)}>Cancel checkout</button>}
    <p className="muted">Your seat is held for ten minutes during checkout.</p>
  </div>;
}

export default function BookingPage({ id, clientId, sandbox }: { id: string; clientId: string; sandbox: boolean }) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [selected, setSelected] = useState<Class>();
  const [customer, setCustomer] = useState({ name: "Jamie Rivera", email: "jamie@example.com" });
  const [customerLocked, setCustomerLocked] = useState(false);
  const [receipt, setReceipt] = useState<Receipt>();
  const [error, setError] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const [availability, setAvailability] = useState<CheckoutInput["availability"]>();
  const [credit, setCredit] = useState<ReturnType<typeof studioCredit> & { token: string }>();
  const [creditPending, setCreditPending] = useState(false);
  const creditToken = useRef("");
  useEffect(() => {
    if (!window.location?.href) return;
    const url = new URL(window.location.href);
    // The credit link carries its token in the fragment (#credit=), which browsers never send to a server.
    const fragment = new URLSearchParams(url.hash.slice(1));
    creditToken.current ||= fragment.get("credit") ?? url.searchParams.get("credit") ?? "";
    if (fragment.has("credit") || url.searchParams.has("credit")) {
      url.searchParams.delete("credit");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${fragment.has("credit") ? "" : url.hash}`);
    }
    if (!creditToken.current) return;
    const controller = new AbortController(); setCreditPending(true);
    void request<ReturnType<typeof studioCredit>>(`/api/bookings/${id}/checkout/credit`, { method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ creditToken: creditToken.current }) })
      .then((details) => { if (!controller.signal.aborted) setCredit({ ...details, token: creditToken.current }); }).catch((cause) => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setCreditPending(false); });
    return () => controller.abort();
  }, [id]);
  useEffect(() => {
    const controller = new AbortController();
    const load = () => request<Catalog>(`/api/bookings/${id}/checkout`, { signal: controller.signal }).then(setCatalog).catch((cause) => { if (!controller.signal.aborted) setError(cause.message); });
    void load(); const timer = setInterval(() => void load(), 15_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [id]);
  useEffect(() => {
    if (!receipt?.orderId) return;
    const timer = setInterval(() => { void request<Receipt>(`/api/bookings/${id}/checkout/orders/${receipt.orderId}`).then(setReceipt).catch(() => {}); }, receipt.webhookConfigured && !receipt.webhookConfirmed ? 3000 : 15_000);
    return () => clearInterval(timer);
  }, [id, receipt?.orderId, receipt?.webhookConfigured, receipt?.webhookConfirmed]);
  const currentSelection = catalog?.sessions.find((session) => session.id === selected?.id);
  const selectionPaused = currentSelection?.bookingPaused;
  const selectedClass = currentSelection ?? (customerLocked ? selected : undefined);
  const timezone = catalog?.studio.timezone ?? "America/Los_Angeles";
  const time = (instant: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(instant));
  const placement = receipt?.current ?? receipt;
  const bookingStatus = receipt?.current?.status;
  const inactive = bookingStatus === "refunded" || bookingStatus === "refund_pending" || bookingStatus === "cancelled";
  const statusText = bookingStatus === "refunded" ? "Refunded" : bookingStatus === "refund_pending" ? "Refund pending" : bookingStatus === "cancelled" ? "Cancelled" : "Booking confirmed";
  function selectClass(session: Class, prefill?: { name?: string; email?: string }) {
    if (customerLocked || receipt || !session.seatsLeft || session.bookingPaused) throw new Error("Checkout is unavailable or already in progress.");
    setSelected(session);
    if (prefill) setCustomer((previous) => ({ name: prefill.name ?? previous.name, email: prefill.email ?? previous.email }));
  }
  useWebMcp(catalog && !receipt ? bookingTools({ sessions: catalog.sessions.filter((session) => !session.bookingPaused), timezone, locked: customerLocked, select: selectClass }) : []);
  // Filters come after every other hook so existing hook order stays stable.
  const [dayFilter, setDayFilter] = useState(""), [typeFilter, setTypeFilter] = useState("");
  const dayKey = (instant: string) => localParts(instant, timezone).dateKey;
  const clock = (instant: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(new Date(instant));
  const days = [...new Map((catalog?.sessions ?? []).map((session) => [dayKey(session.start), {
    key: dayKey(session.start),
    short: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", day: "numeric" }).format(new Date(session.start)),
    long: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric" }).format(new Date(session.start)),
  }])).values()];
  const types = [...new Set((catalog?.sessions ?? []).map((session) => session.classType))];
  const shown = (catalog?.sessions ?? []).filter((session) => (!dayFilter || dayKey(session.start) === dayFilter) && (!typeFilter || session.classType === typeFilter));
  function downloadCalendar() {
    if (!receipt || !catalog) return;
    const url = URL.createObjectURL(new Blob([calendarFile(receipt, catalog.studio.name)], { type: "text/calendar;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "rebook-class.ics"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <main id="main-content" tabIndex={-1} className="customer-booking">
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{receipt && placement ? `${statusText}. ${classTitle(placement.class)}. ${!inactive && receipt.current?.changed ? "Updated: now " : ""}${time(placement.start)}.` : selectedClass ? `${classTitle(selectedClass.title)} selected. Continue to checkout below the class list.` : ""}</p>
    <header className="booking-header"><Link href="/" className="wordmark">rebook<span className="wordmark-dot">.</span></Link><AgentReadyChip /><span className="pill sandbox">{sandbox ? "PayPal sandbox" : "PayPal checkout"}</span></header>
    <p className="eyebrow">Make time for yourself</p><h1>{catalog?.studio.name ?? "Northstar Movement Studio"} · Book a class</h1>
    <p className="muted booking-intro">Find your next good hour. All class times are local to the studio ({timezone}).</p>
    {error && <p className="error" role="alert">{error}</p>}
    {credit && !receipt && <p role="status">Your studio credit: ${credit.remaining} left. Covers classes up to ${credit.remaining}.</p>}
    {receipt && placement ? <section className="booking-receipt"><span className="pill success-pill">{statusText}</span><h2>{inactive ? statusText : "You’re on the list."}</h2><h3>{classTitle(placement.class)}</h3>
      {receipt.current?.changed ? <><p>{inactive ? statusText : `Updated: now ${time(placement.start)}`}</p><p className="muted">Originally: {time(receipt.start)}</p></> : <p>{time(receipt.start)}</p>}
      <p>${receipt.amount} {receipt.currency} paid {receipt.paidWith === "credit" ? "with studio credit" : "via PayPal"}</p>{receipt.paidWith !== "credit" && <p className="capture-reference">PayPal capture ID: <strong>{receipt.captureId}</strong></p>}
      {receipt.webhookConfigured && <p className={receipt.webhookConfirmed ? "success" : "muted"}>{receipt.webhookConfirmed ? "Confirmed by PayPal" : "Payment captured · waiting for PayPal webhook confirmation"}</p>}
      {!inactive && <div className="button-row"><button className="primary" onClick={downloadCalendar}>Add to calendar</button></div>}</section>
      : <div className="booking-layout"><section aria-label="Classes this week" className="booking-classes"><h2>This week at the studio</h2>
        {!catalog && !error && <p role="status">Loading classes…</p>}
        {catalog?.sessions.length === 0 && <p>No upcoming classes are available this week.</p>}
        {catalog && catalog.sessions.length > 0 && <div className="booking-filters">
          <div className="segmented" role="group" aria-label="Day"><button aria-pressed={!dayFilter} onClick={() => setDayFilter("")}>All days</button>{days.map((day) => <button key={day.key} aria-pressed={dayFilter === day.key} onClick={() => setDayFilter(day.key)}>{day.short}</button>)}</div>
          <div className="segmented" role="group" aria-label="Class type"><button aria-pressed={!typeFilter} onClick={() => setTypeFilter("")}>All classes</button>{types.map((type) => <button key={type} aria-pressed={typeFilter === type} onClick={() => setTypeFilter(type)}>{type === "hiit" ? "HIIT" : type[0].toUpperCase() + type.slice(1)}</button>)}</div>
        </div>}
        {catalog && catalog.sessions.length > 0 && !shown.length && <p>No classes match these filters.</p>}
        {days.filter((day) => shown.some((session) => dayKey(session.start) === day.key)).map((day) => <div key={day.key} className="booking-day"><h3>{day.long}</h3>
        {shown.filter((session) => dayKey(session.start) === day.key).map((session) => <button className={`bookable-class type-${session.classType} ${selected?.id === session.id ? "selected" : ""}`} key={session.id} disabled={session.bookingPaused || !session.seatsLeft || customerLocked} aria-pressed={selected?.id === session.id} onClick={() => selectClass(session)}><span><strong>{classTitle(session.title)}</strong><span>{clock(session.start)}</span><span>{session.instructor} · {session.room}</span>{session.bookingPaused && <span>Schedule change in progress — booking paused</span>}</span><span className="class-price"><strong>${session.price}</strong><span>{session.seatsLeft ? `${session.seatsLeft} ${session.seatsLeft === 1 ? "seat" : "seats"} left` : "Full"}</span></span></button>)}</div>)}
      </section><aside className="booking-checkout" aria-label="Class checkout">{selectedClass ? <><p className="eyebrow">Your next class</p><h2>{classTitle(selectedClass.title)}</h2><p>{time(selectedClass.start)}</p><p className="muted">{selectedClass.room} · ${selectedClass.price} USD</p><form ref={form} onSubmit={(event) => event.preventDefault()}><h3>Booking as</h3><label>Name<input required readOnly={customerLocked} minLength={1} maxLength={100} autoComplete="name" value={customer.name} onChange={(event) => setCustomer({ ...customer, name: event.target.value })} /></label><label>Email<input required readOnly={customerLocked} type="email" maxLength={254} autoComplete="email" value={customer.email} onChange={(event) => setCustomer({ ...customer, email: event.target.value })} /></label>
        <details className="booking-availability"><summary>If this class has to move, when can you usually come?</summary><fieldset disabled={customerLocked}><legend>Usual availability (optional)</legend><p className="muted">Times are local to the studio. Leave a group blank for any.</p>
          {(["mornings", "afternoons", "evenings"] as const).map((time) => <label key={time}><input type="checkbox" name="times" value={time} checked={availability?.times?.includes(time) ?? false} onChange={(event) => { const checked = event.target.checked; setAvailability((previous) => {
            const times = checked ? [...(previous?.times ?? []), time] : previous?.times?.filter((item) => item !== time) ?? [];
            return { acceptsSubstitute: true, ...previous, times: times.length ? times : undefined };
          }); }} />{time[0].toUpperCase() + time.slice(1)}</label>)}
          {(["weekdays", "weekends"] as const).map((day) => <label key={day}><input type="checkbox" name="days" value={day} checked={availability?.days?.includes(day) ?? false} onChange={(event) => { const checked = event.target.checked; setAvailability((previous) => {
            const days = checked ? [...(previous?.days ?? []), day] : previous?.days?.filter((item) => item !== day) ?? [];
            return { acceptsSubstitute: true, ...previous, days: days.length ? days : undefined };
          }); }} />{day[0].toUpperCase() + day.slice(1)}</label>)}
          <label><input type="checkbox" name="acceptsSubstitute" checked={availability?.acceptsSubstitute ?? true} onChange={(event) => setAvailability({ ...availability, acceptsSubstitute: event.target.checked })} />I&apos;m happy with a substitute instructor</label>
        </fieldset></details>{customerLocked && <p className="muted">These details are attached to your current checkout.</p>}</form>
        {selectionPaused && <p role="status">Schedule change in progress — booking paused</p>}
        {(customerLocked || (currentSelection && !selectionPaused)) && (creditPending ? <p role="status">Checking studio credit...</p> : credit ? <CreditPayment key={`${id}:${selectedClass.id}:credit`} id={id} token={credit.token} remaining={credit.remaining} session={currentSelection ?? selectedClass} customer={customer} availability={availability} validate={() => Boolean(form.current?.reportValidity())} onSuccess={setReceipt} onLockChange={setCustomerLocked} /> : <Payments key={`${id}:${selectedClass.id}`} id={id} session={currentSelection ?? selectedClass} customer={customer} availability={availability} validate={() => Boolean(form.current?.reportValidity())} clientId={clientId} sandbox={sandbox} onSuccess={setReceipt} onLockChange={setCustomerLocked} />)}
      </> : <><p className="eyebrow">A little space for you</p><h2>Choose your class</h2><p className="muted">Select a class to reserve your spot and pay securely with PayPal or a card.</p></>}{catalog && <AgentConnect bookingId={id} />}</aside></div>}
  </main>;
}
