"use client";

import { useEffect, useRef, useState } from "react";
import type { WaitlistOfferView } from "../../lib/waitlist/service";
import { Payments } from "./booking-page";

const CLOSED = { claimed: "You're booked.", declined: "Thanks for letting us know. We'll offer the spot to the next person.", expired: "This offer has expired. Please contact the studio for another class.", withdrawn: "This class changed. Please contact the studio for an updated class." };
export function OfferDetails({ data }: { data: WaitlistOfferView }) {
  const format = (value: string) => new Intl.DateTimeFormat("en-US", { timeZone: data.studio.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));
  return <><p className="eyebrow">{data.studio.name}</p><h1>{data.session?.title ?? "Your waitlist spot"}</h1>
    {data.session && <><p><time dateTime={data.session.start}>{format(data.session.start)}</time></p><p>{data.session.instructor} · {data.session.room}</p></>}
    {data.status === "offered" ? <><p role="status">We&apos;ve held a spot for you until <time dateTime={data.expiresAt}>{format(data.expiresAt)}</time>.</p>{data.note && <p className="muted">{data.note}</p>}</>
      : <p role="status">{CLOSED[data.status]}</p>}</>;
}
export default function WaitlistOfferPage({ token, clientId }: { token: string; clientId: string }) {
  const [data, setData] = useState<WaitlistOfferView>(), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [paying, setPaying] = useState(false), [locked, setLocked] = useState(false);
  const inFlight = useRef(false);
  const endpoint = `/api/waitlist/${encodeURIComponent(token)}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "This private link is no longer available.");
      setData(body); setPaying(body.checkoutPending);
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Please try again shortly."); });
    return () => controller.abort();
  }, [endpoint]);
  async function choose(action: "claim" | "decline") {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", cache: "no-store", referrerPolicy: "no-referrer", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const body = await response.json(); if (!response.ok) {
        if (response.status === 409 && body.error === "Sorry, this spot was just taken.") setData((previous) => previous ? { ...previous, status: "expired", canClaim: false } : previous);
        throw new Error(body.error ?? "Please try again shortly.");
      }
      setData(body); setPaying(action === "claim" && body.status === "offered" && !body.entitlement);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Please try again shortly."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <main className="customer-booking customer-choice waitlist-offer" id="main-content">
    <header className="booking-header"><span className="brand">rebook<span>.</span></span><span className="muted">A spot opened on your waitlist.</span></header>
    <section className="booking-receipt">
    {data ? <><OfferDetails data={data} />{data.status === "offered" && <>
      {paying && data.session ? <><h2>Complete your booking</h2><p>{data.customer.name} · {data.customer.email}</p>
        <Payments id={data.bookingId} session={data.session} customer={data.customer} waitlistToken={token} clientId={clientId} sandbox validate={() => true}
          onSuccess={(receipt) => { setData({ ...data, status: receipt.spotTaken ? "expired" : "claimed", canClaim: false }); setPaying(false);
            if (receipt.spotTaken) setError("Sorry, this spot was just taken. Your payment needs a refund; please contact the studio."); }} onLockChange={setLocked} />
        <button disabled={locked} onClick={() => setPaying(false)}>Back</button></>
        : <div className="choice-actions"><button className="primary" disabled={busy || !data.canClaim} onClick={() => void choose("claim")}>Claim this spot</button><button disabled={busy} onClick={() => void choose("decline")}>No thanks</button></div>}
    </>}</> : <><h1>Your waitlist spot</h1>{!error && <p role="status">Loading your waitlist spot…</p>}</>}
    {error && <p className="error" role="alert">{error}</p>}
  </section></main>;
}
