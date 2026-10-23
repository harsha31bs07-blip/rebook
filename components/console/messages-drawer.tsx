"use client";

import { useEffect, useRef } from "react";
import type { CustomerMessage } from "@/lib/ai/messages";

export default function MessagesDrawer({ messages, onClose }: { messages: CustomerMessage[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="messages-drawer" aria-labelledby="messages-title" onCancel={onClose}>
    <div className="drawer-header"><div><p className="eyebrow">Customer care</p><h2 id="messages-title">Message drafts</h2></div><button autoFocus onClick={onClose} aria-label="Close message drafts">Close</button></div>
    <p className="muted">{messages.length} drafts ready to review. These messages have not been sent.</p>
    {messages.length === 0 && <p>No affected bookings need a message.</p>}
    {messages.map((message) => <article className="message-card" key={message.bookingId}><span className="muted">Booking {message.bookingId}</span><h3>{message.subject}</h3><p>{message.body}</p></article>)}
  </dialog>;
}
