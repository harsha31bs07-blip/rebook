"use client";

import { useEffect, useRef, useState } from "react";
import type { CustomerMessage } from "@/lib/ai/messages";
import type { OwnerCustomerChoices } from "@/lib/choices/service";
import { api } from "../../lib/client/api";
import { draftOutbox, messageDeepLinks, outboxMessage, outboxState, revisedAt, summarizeOutbox, waitingCustomers, type OutboxCustomer } from "../../lib/choices/outbox";

export default function MessagesDrawer({ messages, links = [], outbox, workspaceId, onUpdated, onClose }: {
  messages: CustomerMessage[]; links?: OwnerCustomerChoices["links"]; outbox?: OutboxCustomer[];
  workspaceId?: string; onUpdated?: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState<"all" | "waiting">("all");
  const [reminders, setReminders] = useState<string[] | null>(null);
  const [reminderIndex, setReminderIndex] = useState(0);
  const [pending, setPending] = useState<string>();
  const [confirmEmail, setConfirmEmail] = useState<string>();
  const inFlight = useRef(false);
  const source = useRef(outbox), revision = useRef(0);
  const [saved, setSaved] = useState<{ source: typeof outbox; rows: OutboxCustomer[] }>();
  const rows = saved && saved.source === outbox ? saved.rows : outbox ?? draftOutbox(messages, links);
  const summary = summarizeOutbox(rows);
  const waiting = waitingCustomers(rows);
  const reminder = reminders ? rows.find((row) => row.customerId === reminders[reminderIndex] && outboxState(row).waiting) : undefined;
  const visible = reminders ? reminder ? [reminder] : [] : filter === "waiting" ? waiting : rows;
  const planId = rows[0]?.planId;
  const emailReady = rows.filter((row) => row.emailDeliverable && !outboxState(row).sent && (!row.delivery || row.delivery.status === "failed"));
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => { element?.close(); previous?.focus(); };
  }, []);
  useEffect(() => { source.current = outbox; }, [outbox]);
  useEffect(() => {
    if (!workspaceId || !planId) return;
    let active = true, checking = false;
    async function refresh() {
      if (inFlight.current || checking) return;
      checking = true; const snapshot = source.current, version = revision.current;
      try {
        const next = await api.emailStatus(workspaceId!, planId!);
        if (active && !inFlight.current && version === revision.current && snapshot === source.current) setSaved({ source: snapshot, rows: next.outbox.filter((row) => row.planId === planId) });
      } catch { /* A status outage leaves the last known delivery state intact. */ }
      finally { checking = false; }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [workspaceId, planId]);

  async function email(row?: OutboxCustomer, resend = false) {
    if (!workspaceId || !planId || inFlight.current) return;
    inFlight.current = true; revision.current++; setPending(`email:${row?.customerId ?? "all"}`); setConfirmEmail(undefined);
    try {
      const next = row ? await api.email(workspaceId, row.planId, row.customerId, !!reminders, resend) : await api.emailAll(workspaceId, planId);
      setSaved({ source: source.current, rows: next.outbox.filter((item) => item.planId === planId) });
      setNotice(row ? `${row.customerName}: email status updated.` : "Customer email statuses updated."); onUpdated?.();
    } catch (error) { setNotice(`${error instanceof Error ? error.message : "Could not confirm email delivery."} Check email status before resending.`); onUpdated?.(); }
    finally { inFlight.current = false; setPending(undefined); }
  }

  async function mark(row: OutboxCustomer, sent: boolean) {
    if (!workspaceId || inFlight.current) return;
    inFlight.current = true; revision.current++; setPending(row.customerId);
    try {
      const next = await api.contact(workspaceId, row.planId, row.customerId, sent);
      setSaved({ source: outbox, rows: next.outbox.filter((item) => item.planId === row.planId) });
      setNotice(`${row.customerName}: ${sent ? "marked Sent by owner. Finish sending in your app; you can undo here." : "sent status undone."}`);
      onUpdated?.();
    } catch (error) {
      setNotice(`${row.customerName}: ${error instanceof Error ? error.message : "Could not save sent status."} Sent status was not updated. Try again.`);
    } finally { inFlight.current = false; setPending(undefined); }
  }

  function share(row: OutboxCustomer, channel: "whatsapp" | "sms" | "email") {
    if (inFlight.current) return;
    const body = outboxMessage(row, window.location.origin, !!reminders);
    const subject = `${reminders ? "Reminder: " : ""}${row.changes[0].subject}`;
    const href = messageDeepLinks(subject, body)[channel];
    if (channel === "whatsapp") window.open(href, "_blank", "noopener,noreferrer");
    else window.location.assign(href);
    void mark(row, true);
  }

  async function copy(row: OutboxCustomer, path?: string) {
    if (inFlight.current) return;
    try {
      await navigator.clipboard.writeText(path ? new URL(path, window.location.origin).href : outboxMessage(row, window.location.origin, !!reminders));
      setNotice(`${row.customerName}: ${path ? "Private link" : "Message"} copied.`);
      await mark(row, true);
    } catch { setNotice(`${row.customerName}: Copy unavailable. Open as customer and copy the address, or use a sharing app.`); }
  }

  return <dialog ref={dialog} className="messages-drawer" aria-labelledby="messages-title" onCancel={onClose}>
    <div className="drawer-header"><div><p className="eyebrow">Customer care</p><h2 id="messages-title">{links.length || outbox?.length ? "Customer outbox" : "Message drafts"}</h2></div><button autoFocus onClick={onClose} aria-label="Close customer messages">Close</button></div>
    <p className="muted">{links.length || outbox?.length ? "Email customers who booked through checkout, or share each private link from your own app and mark it sent. Demo addresses can't receive email. Open as customer to try the reply flow." : `${messages.length} drafts ready to review. Approve the recovery to create private customer links for you to share.`}</p>
    {(links.length > 0 || !!outbox?.length) && <div className="outbox-toolbar">
      <p role="status" aria-live="polite" aria-atomic="true">{summary.sent} sent · {summary.replied} replied · {summary.waiting} waiting <span className="muted">{summary.closed ? `· ${summary.closed} closed without a reply ` : ""}· {summary.notSent} not sent</span></p>
      {!!emailReady.length && workspaceId && !reminders && <button disabled={!!pending} aria-label={`Email ${emailReady.length} customers with addresses`} onClick={() => void email()}>Email {emailReady.length} customers with addresses</button>}
      <div className="outbox-filters" aria-label="Outbox filters"><button aria-pressed={filter === "all" && !reminders} onClick={() => { setFilter("all"); setReminders(null); }}>All customers</button><button aria-pressed={filter === "waiting" && !reminders} onClick={() => { setFilter("waiting"); setReminders(null); }}>Waiting</button><button disabled={!waiting.length || !!pending} onClick={() => { setReminders(waiting.map((row) => row.customerId)); setReminderIndex(0); setNotice("Reminder ready. Choose a sharing app for each waiting customer, then select Next customer."); }}>Remind waiting</button></div>
      <p className="muted">Waiting means sent, with a class choice still unanswered and open. A choice closes when the class starts or after a week. Refund receipts do not need a reply.</p>
      {reminders && <div className="outbox-reminder" role="group" aria-label="Waiting customer reminders"><p role="status" aria-live="polite">Reminder {reminderIndex + 1} of {reminders.length}{reminder ? `: ${reminder.customerName}` : ": this customer is no longer waiting."}</p><button disabled={!!pending || reminderIndex === reminders.length - 1} onClick={() => setReminderIndex(reminderIndex + 1)}>Next customer</button><button onClick={() => setReminders(null)}>Finish reminders</button></div>}
    </div>}
    <p role="status" aria-live="polite" aria-atomic="true">{notice}</p>
    {!rows.length && <p>No affected bookings need a message.</p>}
    {!!rows.length && !visible.length && !reminders && <p>No customers waiting for a reply.</p>}
    <ul className="outbox-list" aria-label="Customer outbox">{visible.map((row) => {
      const status = outboxState(row);
      const canShare = !!workspaceId && row.changes.every((change) => change.path);
      const disabled = !!pending;
      const delivery = reminders ? row.reminderDelivery : row.delivery;
      const sending = pending === `email:${row.customerId}` || (pending === "email:all" && emailReady.includes(row)) || delivery?.status === "queued";
      const retryEmail = delivery && ["failed", "unknown", "bounced"].includes(delivery.status);
      const emailLabel = sending ? "Sending…" : delivery ? ({ queued: "Sending…", sent: "Sent", delivered: "Delivered", failed: "Failed", bounced: "Bounced", unknown: "Unknown — check before resending", deferred: "Deferred" })[delivery.status] : undefined;
      return <li className="outbox-customer" key={row.customerId}>
        <h3>{row.customerName}</h3>
        <div className="outbox-status" aria-live="polite" aria-atomic="true">
          <p>{status.replied ? "Replied" : status.sent ? "Sent" : revisedAt(row) ? "Updated · send again" : "Not sent"}{status.waiting ? " · No reply yet" : status.closed ? " · Choice closed without a reply" : ""}</p>
          {status.sentAt && <p className="muted">Sent by owner · <time dateTime={status.sentAt}>{new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(status.sentAt))}</time></p>}
        </div>
        {emailLabel && <p className="email-status" role="status" aria-live="polite" aria-atomic="true">Email {reminders ? "reminder " : ""}for {row.customerName}: {emailLabel}</p>}
        {reminders && reminder && <p className="outbox-reminder-text">{outboxMessage(row, undefined, true)}</p>}
        {row.changes.map((change) => <article className="message-card" key={change.bookingId}>
          <span className="muted">{change.kind === "receipt" ? "Refund receipt" : change.kind === "choice" ? "Private choice link" : "Message draft"}</span>
          <h4>{change.subject}</h4><p>{change.body}</p>
          <p aria-live="polite" aria-atomic="true">{change.reply ? `Replied: ${change.reply.status}` : ""}</p>
          {change.path && <div className="message-links"><a href={change.path} target="_blank" rel="noopener noreferrer" aria-label={`Open as customer: ${row.customerName}, ${change.subject}`}>Open as customer</a>{row.changes.length === 1 && <button disabled={!canShare || disabled} aria-label={`Copy link for ${row.customerName}, ${change.subject}`} onClick={() => void copy(row, change.path)}>Copy link</button>}</div>}
        </article>)}
        {canShare && <div className="outbox-actions" role="group" aria-label={`Send ${reminders ? "reminder" : "message"} to ${row.customerName}`}>
          <button disabled={disabled} aria-label={`WhatsApp ${row.customerName}`} onClick={() => share(row, "whatsapp")}>WhatsApp</button>
          <button disabled={disabled} aria-label={`SMS ${row.customerName}`} onClick={() => share(row, "sms")}>SMS</button>
          <button disabled={disabled || !row.emailDeliverable || sending || (!!delivery && !retryEmail)} aria-label={`${retryEmail ? "Send again to" : "Email"} ${row.customerName}`} aria-describedby={!row.emailDeliverable ? `demo-email-${row.customerId}` : undefined} onClick={() => retryEmail ? setConfirmEmail(row.customerId) : void email(row)}>{retryEmail ? "Send again" : "Email"}</button>
          <button disabled={disabled} aria-label={`Email draft for ${row.customerName}`} onClick={() => share(row, "email")}>Email draft</button>
          <button disabled={disabled} aria-label={`Copy message for ${row.customerName}`} onClick={() => void copy(row)}>Copy</button>
          {status.sent && <button disabled={disabled} aria-label={`Undo sent for ${row.customerName}`} onClick={() => void mark(row, false)}>Undo sent</button>}
        </div>}
        {canShare && !row.emailDeliverable && <p className="muted" id={`demo-email-${row.customerId}`}>Demo address · not sent</p>}
        {confirmEmail === row.customerId && <div className="outbox-reminder" role="group" aria-label={`Confirm email again to ${row.customerName}`}><p>A previous email may already have arrived. Check with {row.customerName} before sending again.</p><button disabled={disabled} aria-label={`Confirm send again to ${row.customerName}`} onClick={() => void email(row, true)}>Confirm send again</button><button onClick={() => setConfirmEmail(undefined)} aria-label={`Cancel email again to ${row.customerName}`}>Cancel</button></div>}
      </li>;
    })}</ul>
  </dialog>;
}
