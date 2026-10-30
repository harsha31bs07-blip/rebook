"use client";

import type { ownerWaitlist } from "../../lib/waitlist/service";
export default function WaitlistPanel({ classes = [], timezone, onMessages }: { classes?: ReturnType<typeof ownerWaitlist>; timezone: string; onMessages(): void }) {
  const format = (value: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
  return <section id="waitlist" className="customer-replies" aria-labelledby="waitlist-title"><h3 id="waitlist-title">Waitlist</h3>
    <p className="muted">Spots are held for up to 12 hours, until one hour before class.</p>
    {classes.length ? <button onClick={onMessages}>Message waitlist customers</button> : <p>No waiting customers.</p>}
    <ul>{classes.map((item) => <li key={item.sessionId}><h4>{item.title}</h4><p role="status">{item.waiting} waiting · {item.offers.filter((offer) => offer.status === "offered").length} open offers</p>
      {item.offers.length > 0 && <ul>{item.offers.map((offer) => <li key={offer.id}>{offer.customerName} · {offer.status === "offered" ? <>held until <time dateTime={offer.expiresAt}>{format(offer.expiresAt)}</time></> : offer.status}</li>)}</ul>}
    </li>)}</ul></section>;
}
