"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Receipt } from "../../lib/checkout/service";

/** PayPal sends the buyer here after approving an order an AI agent prepared; capture goes through the normal checkout path. */
export default function PayPalReturn({ bookingId, orderId, timezone }: { bookingId: string; orderId?: string; timezone: string }) {
  const [receipt, setReceipt] = useState<Receipt>(), [error, setError] = useState(orderId ? "" : "This PayPal link is missing its order. Go back to the studio and try again.");
  const started = useRef(false);
  useEffect(() => {
    if (!orderId || started.current) return;
    started.current = true;
    void (async () => {
      try {
        const response = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "We couldn't confirm this payment. Please contact the studio.");
        setReceipt(body);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "We couldn't confirm this payment. Please contact the studio."); }
    })();
  }, [bookingId, orderId]);
  const format = (value: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));
  return <main className="customer-booking customer-choice" id="main-content">
    <header className="booking-header"><span className="brand">rebook<span>.</span></span><span className="muted">Booked by your assistant, paid by you with PayPal.</span></header>
    {receipt ? receipt.spotTaken ? <><h1>Sorry, this spot was just taken</h1><p role="status">Your payment of ${receipt.amount} is being refunded to your PayPal account.</p></>
      : <><h1>You&apos;re booked</h1><p role="status">{receipt.class} · <time dateTime={receipt.start}>{format(receipt.start)}</time></p>
        <p className="muted">Paid ${receipt.amount} with PayPal (sandbox){receipt.captureId ? ` · capture ${receipt.captureId}` : ""}.</p></>
      : error ? <><h1>Payment not completed</h1><p role="alert">{error}</p></> : <><h1>Confirming your payment</h1><p role="status">Checking with PayPal…</p></>}
    <p><Link href={`/b/${bookingId}`}>Back to the studio&apos;s classes</Link></p>
  </main>;
}
