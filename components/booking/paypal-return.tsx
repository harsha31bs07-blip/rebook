"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Receipt } from "../../lib/checkout/service";

type Outcome = { kind: "checking" } | { kind: "paid"; receipt: Receipt } | { kind: "stopped"; title: string; message: string } | { kind: "unknown"; message: string };

const UNCONFIRMED = "PayPal may still be processing this. Please don't pay again until it's confirmed.";

/** Only an answer that rules out a charge may say so; anything else keeps the order open to be checked again. */
export function captureOutcome(status: number, body: { error?: string; code?: string; orderId?: string } | undefined): Outcome {
  if (status >= 200 && status < 300 && body?.orderId) return { kind: "paid", receipt: body as Receipt };
  if (body?.code === "RESTART_CHECKOUT") return { kind: "stopped", title: "Payment not completed", message: body.error ?? "This checkout ended. Choose a class again." };
  if (body?.code === "INSTRUMENT_DECLINED") return { kind: "stopped", title: "Payment declined", message: body.error ?? "PayPal declined this payment. Choose another payment method and start again." };
  if (status === 422) return { kind: "stopped", title: "Payment not approved yet", message: body?.error ?? "PayPal hasn't approved this payment. Go back and approve it, or choose another method." };
  if (status === 404) return { kind: "stopped", title: "We can't find this payment", message: "This PayPal link doesn't match a checkout at this studio. Go back to the studio and try again." };
  return { kind: "unknown", message: UNCONFIRMED };
}

export function ReturnView({ outcome, timezone, onCheck }: { outcome: Outcome; timezone: string; onCheck: () => void }) {
  const format = (value: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));
  if (outcome.kind === "checking") return <><h1>Confirming your payment</h1><p role="status">Checking with PayPal…</p></>;
  if (outcome.kind === "stopped") return <><h1>{outcome.title}</h1><p role="alert">{outcome.message}</p></>;
  if (outcome.kind === "unknown") return <><h1>We haven&apos;t confirmed this payment yet</h1><p role="alert">{outcome.message}</p><button className="primary" onClick={onCheck}>Check this payment again</button></>;
  const { receipt } = outcome, paid = <p className="muted">Paid ${receipt.amount} with PayPal (sandbox){receipt.captureId ? ` · capture ${receipt.captureId}` : ""}.</p>;
  if (receipt.spotTaken) return <><h1>Sorry, this spot was just taken</h1><p role="status">We&apos;re returning your ${receipt.amount} to your PayPal account. The studio can see this until it&apos;s done.</p></>;
  const current = receipt.current;
  // On a later visit the class may have moved or been refunded by a recovery: the booking as it stands now comes first.
  if (current?.changed && ["confirmed", "moved"].includes(current.status)) return <><h1>Your booking has changed</h1><p role="status">{current.class} · <time dateTime={current.start}>{format(current.start)}</time></p>{paid}<p className="muted">You first booked {receipt.class}, {format(receipt.start)}.</p></>;
  if (current?.changed) return <><h1>This booking is no longer active</h1><p role="status">{receipt.class}, {format(receipt.start)} · status: {current.status.replaceAll("_", " ")}.</p>{paid}</>;
  return <><h1>You&apos;re booked</h1><p role="status">{receipt.class} · <time dateTime={receipt.start}>{format(receipt.start)}</time></p>{paid}</>;
}

/** PayPal sends the buyer here after approving an order an AI agent prepared; capture goes through the normal checkout path. */
export default function PayPalReturn({ bookingId, orderId, timezone }: { bookingId: string; orderId?: string; timezone: string }) {
  const [outcome, setOutcome] = useState<Outcome>(orderId ? { kind: "checking" } : { kind: "stopped", title: "Payment not completed", message: "This PayPal link is missing its order. Go back to the studio and try again." });
  const started = useRef(false);
  const capture = useCallback(async () => {
    if (!orderId) return;
    try {
      const response = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      setOutcome(captureOutcome(response.status, await response.json().catch(() => undefined)));
    } catch { setOutcome({ kind: "unknown", message: UNCONFIRMED }); }
  }, [bookingId, orderId]);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void capture();
  }, [capture]);
  return <main className="customer-booking customer-choice" id="main-content">
    <header className="booking-header"><span className="brand">rebook<span>.</span></span><span className="muted">Booked by your assistant, paid by you with PayPal.</span></header>
    <ReturnView outcome={outcome} timezone={timezone} onCheck={() => { setOutcome({ kind: "checking" }); void capture(); }} />
    <p><Link href={`/b/${bookingId}`}>Back to the studio&apos;s classes</Link></p>
  </main>;
}
