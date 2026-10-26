"use client";

import { useEffect, useRef, useState } from "react";
import type { CustomerMessage } from "@/lib/ai/messages";
import type { OwnerCustomerChoices } from "@/lib/choices/service";

export default function MessagesDrawer({ messages, links = [], onClose }: { messages: CustomerMessage[]; links?: OwnerCustomerChoices["links"]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => { element?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className="messages-drawer" aria-labelledby="messages-title" onCancel={onClose}>
    <div className="drawer-header"><div><p className="eyebrow">Customer care</p><h2 id="messages-title">{links.length ? "Customer messages" : "Message drafts"}</h2></div><button autoFocus onClick={onClose} aria-label="Close customer messages">Close</button></div>
    <p className="muted">{links.length ? "Private links are ready to share. Open as customer to try the reply flow." : `${messages.length} drafts ready to review. Approve the recovery to create private customer links.`}</p>
    {notice && <p role="status">{notice}</p>}
    {messages.length === 0 && <p>No affected bookings need a message.</p>}
    {messages.toSorted((a, b) => Number(links.find((link) => link.bookingId === b.bookingId)?.kind === "choice") - Number(links.find((link) => link.bookingId === a.bookingId)?.kind === "choice")).map((message) => {
      const link = links.find((item) => item.bookingId === message.bookingId);
      return <article className="message-card" key={message.bookingId}><span className="muted">{link ? link.kind === "receipt" ? "Refund receipt" : "Private choice link" : "Message draft"}</span><span className="muted">Booking {message.bookingId}</span><h3>{message.subject}</h3><p>{link ? message.body.replace("Doesn't work? Reply for a refund.", "Use your private link to keep your new time, find another class, or take a refund.") : message.body}</p>{link && <div className="message-links"><a href={link.path} target="_blank" rel="noopener noreferrer">Open as customer</a><button onClick={async () => { try { await navigator.clipboard.writeText(new URL(link.path, window.location.origin).href); setNotice("Private link copied."); } catch { setNotice("Copy unavailable. Open as customer and copy the address."); } }}>Copy link</button></div>}</article>;
    })}
  </dialog>;
}
