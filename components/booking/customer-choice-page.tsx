"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChoiceInput, CustomerChoiceView } from "@/lib/choices/service";
import { entitlementReceipt } from "../../lib/domain/entitlements";
import type { ChoiceProposal } from "@/lib/choices/assistant";
import { choiceTools } from "../../lib/webmcp/tools";
import { useWebMcp } from "../../lib/webmcp/use-webmcp";

export default function CustomerChoicePage({ token }: { token: string }) {
  const [data, setData] = useState<CustomerChoiceView>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [message, setMessage] = useState("");
  const [asking, setAsking] = useState(false);
  const [proposal, setProposal] = useState<ChoiceProposal>();
  const proposalHeading = useRef<HTMLHeadingElement>(null);
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
    try { await request(input); focusResult.current = true; setPicking(false); setProposal(undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Please try again shortly."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function ask(text: string, signal?: AbortSignal): Promise<ChoiceProposal> {
    if (inFlight.current || !data?.canChoose) throw new Error("Please wait for your current choice.");
    inFlight.current = true; ++revision.current; setAsking(true); setError(""); setProposal(undefined); setMessage(text);
    try {
      const response = await fetch(`${endpoint}/assistant`, { method: "POST", cache: "no-store", referrerPolicy: "no-referrer", signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Please try again shortly.");
      setProposal(body); return body;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Please try again shortly."); throw cause; }
    finally { inFlight.current = false; setAsking(false); }
  }
  useWebMcp(() => choiceTools({ canChoose: !!data?.canChoose, busy: busy || asking, ask }));
  useEffect(() => { if (proposal) proposalHeading.current?.focus(); }, [proposal]);
  const when = (instant: string) => new Intl.DateTimeFormat("en-US", { timeZone: data?.studio.timezone,
    weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(instant));
  const receipt = data?.receipt;
  const entitlement = data?.entitlement;
  // Only the instructor or room changed: the customer keeps a class, not a new time.
  const sameTime = !!data?.after && Date.parse(data.after.start) === Date.parse(data.before.start);
  const keepLabel = !sameTime ? "Keep my new time" : data!.after!.instructor !== data!.before.instructor ? `Keep my class with ${data!.after!.instructor.split(" ")[0]}` : "Keep my class";
  const returned = entitlement ? entitlementReceipt(entitlement, data?.packBalance, data?.after?.start ?? data?.before.start, data?.studio.timezone) : undefined;
  const cancelLabel = entitlement?.kind === "pack" ? `Return the visit to my ${entitlement.name}${data?.packBalance !== undefined && !receipt ? ` (${data.packBalance + 1} left after)` : ""}` : "Cancel this booking";
  const restored = receipt?.status === "CREDIT_RESTORED";
  const completed = receipt && ["COMPLETED", "SIMULATED", "CREDIT_RESTORED", "VISIT_RETURNED"].includes(receipt.status);
  useEffect(() => {
    if (!busy && focusResult.current && resultHeading.current) {
      resultHeading.current.focus(); focusResult.current = false;
    }
  }, [busy, data]);
  return <main id="main-content" tabIndex={-1} className="customer-booking customer-choice">
    <header className="booking-header"><span className="brand">rebook<span>.</span></span><span className="muted">A little change. A choice for you.</span></header>
    <section className="choice-intro"><p className="eyebrow">{data?.studio.name ?? "Your studio"}</p><h1>{data?.kind === "receipt" ? entitlement ? "Your booking receipt." : "Your refund receipt." : "Your class. Your call."}</h1><p className="muted">{data?.kind === "receipt" ? entitlement ? "Your studio has cancelled this booking." : "Your studio has arranged a refund to your original payment." : "Plans change. Let’s find what works for you."}</p></section>
    {error && <p className="error error-box" role="alert">{error}</p>}
    {error.includes("free server") && <Link href="/">Start a fresh demo</Link>}
    {!data && !error && <p role="status">Opening your private booking…</p>}
    {data && <>
      {data.simulated && <p className="choice-simulation">Simulated payment · Demo only. No real money moves.</p>}
      <section className="choice-change" aria-label="Your class update">
        <div><p className="eyebrow">Originally</p><h2>{data.before.title}</h2><p>{when(data.before.start)}</p><span className="muted">with {data.before.instructor}</span></div>
        <span className="choice-arrow" aria-hidden="true">→</span>
        <div><p className="eyebrow">{data.kind === "receipt" || data.reply?.action === "refund" || data.reply?.action === "credit" ? "Your update" : "Your new class"}</p><h2>{data.reply?.action === "credit" ? "Kept as studio credit" : data.reply?.action === "refund" || data.kind === "receipt" ? entitlement ? cancelLabel : data.paidWith === "credit" ? "Return to your studio credit" : "Refund to your original payment" : data.after?.title}</h2>{data.after && data.reply?.action !== "refund" && data.reply?.action !== "credit" && <><p>{when(data.after.start)}</p><span className="muted">with {data.after.instructor}</span></>}</div>
      </section>
      {entitlement?.kind === "pack" && data.packBalance !== undefined && <p className="muted">{entitlement.name} · {data.packBalance} visits left</p>}
      <details key={data.reply?.action === "refund" ? "original" : "current"} className="choice-message" open={data.reply?.action !== "refund"}><summary>{data.reply?.action === "refund" ? "Original message from your studio" : "A note from your studio"}</summary><p>{data.message.body}</p></details>
      <div aria-live="polite" aria-atomic="true" role="status" className="choice-status">
        {busy ? <p>Saving your choice…</p> : receipt ? <><h2 ref={resultHeading} tabIndex={-1}>{returned && receipt.status === "VISIT_RETURNED" ? returned : restored ? "Returned to your studio credit" : completed ? "Refund completed" : ["FAILED", "NEEDS_REVIEW"].includes(receipt.status) ? "Refund needs attention" : "Refund pending"}</h2>{!entitlement && <p>${receipt.amount} {restored ? "returned to your studio credit" : data.reply?.action === "move" ? "price difference" : "to your original payment"}{restored ? "" : receipt.status === "SIMULATED" ? " · simulated" : " · PayPal"}</p>}{!entitlement && receipt.paypalId && <p className="choice-receipt-id">Refund ID: <strong>{receipt.paypalId}</strong></p>}<p className="muted">{completed ? "Your receipt is saved here." : "This page updates automatically as your refund is confirmed."}</p></>
          : data.credit ? <><h2 ref={resultHeading} tabIndex={-1}>Your ${data.credit.amount} studio credit</h2><p>{data.credit.status === "unavailable" ? "This credit is unavailable because its original payment was refunded or reversed." : "Use it for any class; no refund needed."}</p><p className="muted">${data.credit.remaining} left</p>{data.credit.status === "available" && <><a className="primary" href={data.credit.path} referrerPolicy="no-referrer">Book a class with your credit</a>
            <p className="muted">{["sent", "delivered", "deferred"].includes(data.credit.emailed ?? "") ? "We've emailed you this link, so your credit stays easy to reach after this page closes."
              : `This page closes on ${new Intl.DateTimeFormat("en-US", { timeZone: data.studio.timezone, month: "short", day: "numeric" }).format(new Date(data.credit.readableUntil))}; your credit doesn't. Bookmark the link above to keep it.`}</p></>}</>
          : data.reply && <><h2 ref={resultHeading} tabIndex={-1}>You’re all set.</h2><p>{data.reply.action === "keep" ? sameTime ? "Your class is confirmed. See you there." : "Your new time is confirmed. See you in class." : "Your place in your chosen class is confirmed."}</p></>}
      </div>
      {data.canChoose && <section className="choice-assistant" aria-labelledby="assistant-label" aria-busy={asking}>
        <label id="assistant-label" htmlFor="assistant-message">Tell us what works for you</label>
        <textarea id="assistant-message" maxLength={300} rows={3} value={message} disabled={busy || asking} placeholder={entitlement ? "Anything after 6pm this week, otherwise cancel" : "Anything after 6pm this week, otherwise a refund"} onChange={(event) => setMessage(event.target.value)} />
        <button disabled={busy || asking || !message.trim()} onClick={() => { void ask(message).catch(() => {}); }}>Ask</button>
        {asking && <p role="status">Checking this week’s classes…</p>}
        {proposal && <article className="choice-proposal" aria-labelledby="proposal-heading">
          <h2 id="proposal-heading" ref={proposalHeading} tabIndex={-1}>{proposal.action === "clarify" ? "A quick question" : proposal.class ? `${proposal.class.title} · ${new Intl.DateTimeFormat("en-US", { timeZone: data.studio.timezone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(proposal.class.start))} with ${proposal.class.instructor}` : proposal.action === "credit" ? "Keep studio credit" : proposal.action === "refund" ? entitlement ? cancelLabel : data.paidWith === "credit" ? "Return to your studio credit" : "Refund to your original payment" : "Keep your new class"}</h2>
          <p className="muted">Checked {proposal.checked} classes</p><p>{proposal.reply}</p>
          {proposal.action !== "clarify" && <><p>{entitlement ? proposal.action === "refund" ? cancelLabel : `Covered by your ${entitlement.name}` : proposal.action === "credit" ? `$${proposal.credit} studio credit` : proposal.action === "refund" ? data.paidWith === "credit" ? `$${proposal.refund} returned to your studio credit` : `$${proposal.refund} refund to your original payment` : proposal.refund !== "0.00" ? data.paidWith === "credit" ? `$${proposal.refund} returned to your studio credit` : `$${proposal.refund} back to your PayPal` : "No change to what you paid"}</p>
            <div className="choice-proposal-buttons"><button className="primary" disabled={busy || asking} onClick={() => { if (proposal.action === "move" && proposal.sessionId) void choose({ action: "move", sessionId: proposal.sessionId }); else if (proposal.action === "keep" || proposal.action === "refund" || proposal.action === "credit") void choose({ action: proposal.action }); }}>Confirm</button><button disabled={busy || asking} onClick={() => setProposal(undefined)}>Not quite</button></div></>}
        </article>}
      </section>}
      {data.canChoose && <section className="choice-actions" aria-label="Choose what works for you" aria-busy={busy || asking}>
        <button className="primary" disabled={busy || asking} onClick={() => void choose({ action: "keep" })}>{keepLabel}</button>
        <button disabled={busy || asking} aria-expanded={picking} onClick={() => setPicking(!picking)}>Pick another class <span className="muted">This week · no extra cost</span></button>
        {entitlement ? <button disabled={busy || asking} onClick={() => void choose({ action: "refund" })}>{cancelLabel}</button> : data.paidWith === "credit" ? <button disabled={busy || asking || !Number(data.creditRefundable)} onClick={() => void choose({ action: "refund" })}>Return to my studio credit <span>${data.creditRefundable}</span></button>
          : <><button disabled={busy || asking || data.refundable === "0.00"} onClick={() => void choose({ action: "refund" })}>Refund me <span>${data.refundable}</span></button>
            <button disabled={busy || asking || data.refundable === "0.00"} onClick={() => void choose({ action: "credit" })}>Keep ${Number(data.refundable)} as studio credit <span className="muted">Use it for any class; no refund needed.</span></button></>}
        <p className="muted choice-small">{entitlement ? "Cancelling releases your seat. Your booking system keeps your balances." : data.paidWith === "credit" ? "Returns go to your studio credit. Starting a return makes your choice final." : "Refunds go to your original payment. Choosing a credit or starting a refund makes your choice final."}</p>
      </section>}
      {picking && data.canChoose && <section className="choice-options" aria-labelledby="class-options"><h2 id="class-options">A fresh spot in your week</h2><p className="muted">Your class type first. Every option has a free seat.</p>{data.alternatives.length === 0 && <p>No eligible classes are available this week. {entitlement ? "You can still keep your time or cancel this booking." : "You can still keep your time or take a refund."}</p>}{data.alternatives.map((session) => <button className="choice-option" key={session.id} disabled={busy || asking} onClick={() => void choose({ action: "move", sessionId: session.id })}><strong>{session.title}</strong><span>{when(session.start)}</span><span className="muted">{session.instructor} · {session.seatsLeft} {session.seatsLeft === 1 ? "seat" : "seats"} left</span><span>{entitlement ? `Covered by your ${entitlement.name}` : <>{session.difference !== "0.00" ? `$${session.difference} refunded · ` : ""}${session.price}</>}</span></button>)}</section>}
      {!data.canChoose && !data.reply && data.kind === "choice" && <p className="muted">{data.choicesClosed ? "Choices are closed. Your class update remains available here." : "Your booking has changed. Please use your studio’s latest message."}</p>}
      {receipt && ["REQUESTED", "FAILED", "NEEDS_REVIEW"].includes(receipt.status) && data.reply && <button disabled={busy} onClick={() => void choose(data.reply!.action === "move" && data.after ? { action: "move", sessionId: data.after.id } : { action: "refund" })}>Check / retry my refund</button>}
      <footer className="choice-footer muted">A private link, just for you. All times shown in {data.studio.timezone}.</footer>
    </>}
  </main>;
}
