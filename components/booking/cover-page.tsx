"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CoverView } from "@/lib/recovery/cover-pay";

const PAYOUT_LABELS: Record<string, string> = { REQUESTED: "Sending to PayPal", PENDING: "Processing with PayPal", SUCCESS: "Paid",
  UNCLAIMED: "Waiting for you to claim it in PayPal", ONHOLD: "On hold at PayPal", FAILED: "Payment failed", RETURNED: "Returned", BLOCKED: "Blocked",
  REFUNDED: "Refunded", REVERSED: "Reversed", DENIED: "Declined by PayPal" };

export default function CoverPage({ token }: { token: string }) {
  const [data, setData] = useState<CoverView>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const endpoint = `/api/instructor/${encodeURIComponent(token)}`;
  const load = useCallback(async (init?: RequestInit) => {
    const response = await fetch(endpoint, { cache: "no-store", referrerPolicy: "no-referrer", ...init });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Please try again shortly.");
    setData(body); setError("");
  }, [endpoint]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>, live = true;
    const poll = async () => { try { await load(); } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : "Please try again shortly."); } if (live) timer = setTimeout(poll, 5000); };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [load]);
  async function respond(action: "accept" | "decline") {
    setBusy(true); setError("");
    try { await load({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }); heading.current?.focus(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Please try again shortly."); }
    finally { setBusy(false); }
  }
  const when = (instant: string) => new Intl.DateTimeFormat("en-US", { timeZone: data?.studio.timezone, weekday: "long", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(instant));
  const title = !data ? "Cover request" : data.status === "withdrawn" ? "This class went back to its regular instructor." : data.payout?.status === "SUCCESS" ? "Paid. Thank you for covering." : data.status === "replaced" ? "This class has been reassigned." : data.status === "accepted" ? "You’re teaching this class."
    : data.status === "declined" ? "You declined this cover." : `Can you cover ${data.class.title}?`;
  return <main id="main-content" tabIndex={-1} className="customer-booking customer-choice">
    <header className="booking-header"><span className="brand">rebook<span>.</span></span><span className="muted">A cover request from your studio.</span></header>
    <section className="choice-intro"><p className="eyebrow">{data?.studio.name ?? "Your studio"}</p><h1 ref={heading} tabIndex={-1}>{title}</h1>
      {data && <p className="muted">{data.status === "withdrawn" ? `The disruption was withdrawn. ${data.original} is back.${data.payout ? " Your existing payout stays recorded." : " This cover can no longer be accepted or paid."}` : `${data.original} is unavailable. Cover fee $${data.fee}, paid with PayPal.`}</p>}</section>
    {error && <p className="error error-box" role="alert">{error}</p>}
    {error.includes("free server") && <Link href="/">Start a fresh demo</Link>}
    {!data && !error && <p role="status">Opening your cover request…</p>}
    {data && <>
      <section className="choice-change" aria-label="The class"><div><p className="eyebrow">Class</p><h2>{data.class.title}</h2><p>{when(data.class.start)}</p>
        <span className="muted">{data.class.room}</span></div></section>
      <div role="status" aria-live="polite" aria-atomic="true" className="choice-status">
        {data.payout && <><h2>{PAYOUT_LABELS[data.payout.status] ?? data.payout.status}</h2><p>${data.payout.amount} · PayPal payout (sandbox)</p>
          {data.payout.itemId && <p className="choice-receipt-id">Payout item: <strong>{data.payout.itemId}</strong></p>}</>}
      </div>
      {data.canRespond && <section className="choice-actions" aria-label="Respond to the cover request" aria-busy={busy}>
        <button className="primary" disabled={busy || data.status === "accepted"} onClick={() => void respond("accept")}>{data.status === "accepted" ? "Accepted" : "Yes, I’ll cover it"}</button>
        <button disabled={busy || data.status === "declined"} onClick={() => void respond("decline")}>{data.status === "declined" ? "Declined" : "I can’t this time"}</button>
        <p className="muted choice-small">Your studio sees your answer straight away. You can change it until the class starts or you are paid.</p>
      </section>}
      <footer className="choice-footer muted">A private link, just for you. Times shown in {data.studio.timezone}.</footer>
    </>}
  </main>;
}
