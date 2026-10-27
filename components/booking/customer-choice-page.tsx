"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChoiceInput, CustomerChoiceView } from "@/lib/choices/service";

export default function CustomerChoicePage({ token }: { token: string }) {
  const [data, setData] = useState<CustomerChoiceView>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const inFlight = useRef(false);
  const revision = useRef(0);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const focusResult = useRef(false);
  const endpoint = `/api/choices/${encodeURIComponent(token)}`;
  const request = useCallback(async (input?: ChoiceInput, signal?: AbortSignal) => {
    const current = ++revision.current;
    const response = await fetch(endpoint, { method: input ? "POST" : "GET", cache: "no-store", referrerPolicy: "no-referrer", signal,
      ...(input ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}) });
    const body = await response.json();
    if (!response.ok) {
      if (current === revision.current && [404, 410].includes(response.status)) setData(undefined);
      throw new Error(body.error ?? "Please try again shortly.");
    }
    if (current === revision.current) { setData(body); setError(""); }
  }, [endpoint]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { if (!inFlight.current) await request(undefined, controller.signal); }
      catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Please try again shortly."); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [request]);
  async function choose(input: ChoiceInput) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { await request(input); focusResult.current = true; setPicking(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Please try again shortly."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const when = (instant: string) => new Intl.DateTimeFormat("en-US", { timeZone: data?.studio.timezone,
    weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(instant));
  const receipt = data?.receipt;
  const completed = receipt && ["COMPLETED", "SIMULATED"].includes(receipt.status);
  useEffect(() => {
    if (!busy && focusResult.current && resultHeading.current) {
      resultHeading.current.focus(); focusResult.current = false;
    }
  }, [busy, data]);
  return <main id="main-content" tabIndex={-1} className="customer-booking customer-choice">
    <header className="booking-header"><span className="brand">rebook<span>.</span></span><span className="muted">A little change. A choice for you.</span></header>
    <section className="choice-intro"><p className="eyebrow">{data?.studio.name ?? "Your studio"}</p><h1>{data?.kind === "receipt" ? "Your refund receipt." : "Your class. Your call."}</h1><p className="muted">{data?.kind === "receipt" ? "Your studio has arranged a refund to your original payment." : "Plans change. Let’s find what works for you."}</p></section>
    {error && <p className="error error-box" role="alert">{error}</p>}
    {!data && !error && <p role="status">Opening your private booking…</p>}
    {data && <>
      {data.simulated && <p className="choice-simulation">Simulated payment · Demo only. No real money moves.</p>}
      <section className="choice-change" aria-label="Your class update">
        <div><p className="eyebrow">Originally</p><h2>{data.before.title}</h2><p>{when(data.before.start)}</p><span className="muted">with {data.before.instructor}</span></div>
        <span className="choice-arrow" aria-hidden="true">→</span>
        <div><p className="eyebrow">{data.kind === "receipt" || data.reply?.action === "refund" ? "Your update" : "Your new class"}</p><h2>{data.reply?.action === "refund" || data.kind === "receipt" ? "Refund to your original payment" : data.after?.title}</h2>{data.after && data.reply?.action !== "refund" && <><p>{when(data.after.start)}</p><span className="muted">with {data.after.instructor}</span></>}</div>
      </section>
      <details key={data.reply?.action === "refund" ? "original" : "current"} className="choice-message" open={data.reply?.action !== "refund"}><summary>{data.reply?.action === "refund" ? "Original message from your studio" : "A note from your studio"}</summary><p>{data.message.body}</p></details>
      <div aria-live="polite" aria-atomic="true" role="status" className="choice-status">
        {busy ? <p>Saving your choice…</p> : receipt ? <><h2 ref={resultHeading} tabIndex={-1}>{completed ? "Refund completed" : receipt.status === "FAILED" ? "Refund needs attention" : "Refund pending"}</h2><p>${receipt.amount} {data.reply?.action === "move" ? "price difference" : "to your original payment"}{receipt.status === "SIMULATED" ? " · simulated" : " · PayPal"}</p>{receipt.paypalId && <p className="choice-receipt-id">Refund ID: <strong>{receipt.paypalId}</strong></p>}<p className="muted">{completed ? "Your receipt is saved here." : "This page updates automatically as your refund is confirmed."}</p></>
          : data.reply && <><h2 ref={resultHeading} tabIndex={-1}>You’re all set.</h2><p>{data.reply.action === "keep" ? "Your new time is confirmed. See you in class." : "Your place in your chosen class is confirmed."}</p></>}
      </div>
      {data.canChoose && <section className="choice-actions" aria-label="Choose what works for you" aria-busy={busy}>
        <button className="primary" disabled={busy} onClick={() => void choose({ action: "keep" })}>Keep my new time <span aria-hidden="true">↗</span></button>
        <button disabled={busy} aria-expanded={picking} onClick={() => setPicking(!picking)}>Pick another class <span className="muted">This week · no extra cost</span></button>
        <button disabled={busy || data.refundable === "0.00"} onClick={() => void choose({ action: "refund" })}>Refund me <span>${data.refundable}</span></button>
        <p className="muted choice-small">Refunds go to your original payment. Once a refund starts, your choice is final.</p>
      </section>}
      {picking && data.canChoose && <section className="choice-options" aria-labelledby="class-options"><h2 id="class-options">A fresh spot in your week</h2><p className="muted">Your class type first. Every option has a free seat.</p>{data.alternatives.length === 0 && <p>No eligible classes are available this week. You can still keep your time or take a refund.</p>}{data.alternatives.map((session) => <button className="choice-option" key={session.id} disabled={busy} onClick={() => void choose({ action: "move", sessionId: session.id })}><strong>{session.title}</strong><span>{when(session.start)}</span><span className="muted">{session.instructor} · {session.seatsLeft} {session.seatsLeft === 1 ? "seat" : "seats"} left</span><span>{session.difference !== "0.00" ? `$${session.difference} refunded · ` : ""}${session.price}</span></button>)}</section>}
      {!data.canChoose && !data.reply && data.kind === "choice" && <p className="muted">Your booking has changed. Please use your studio’s latest message.</p>}
      {receipt && ["REQUESTED", "FAILED"].includes(receipt.status) && data.reply && <button disabled={busy} onClick={() => void choose(data.reply!.action === "move" && data.after ? { action: "move", sessionId: data.after.id } : { action: "refund" })}>Check / retry my refund</button>}
      <footer className="choice-footer muted">A private link, just for you. All times shown in {data.studio.timezone}.</footer>
    </>}
  </main>;
}
