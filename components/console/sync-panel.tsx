"use client";

import { useState } from "react";
import type { ownerSync } from "../../lib/sync/service";
import type { SyncChange } from "../../lib/sync/feed";

export function changeDescription(change: SyncChange, timezone: string): string {
  const when = (start: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(start));
  switch (change.type) {
    case "session.moved": return `${change.session.title} moved to ${when(change.after.start)} (${change.after.instructor}, ${change.after.room})`;
    case "session.cancelled": return `${change.session.title} cancelled`;
    case "booking.moved": return `${change.customer.name} moved to ${change.to.title}, ${when(change.to.start)}`;
    case "booking.cancelled": return `${change.customer.name}: ${change.session.title} ${change.reason}${change.amount ? ` ($${change.amount})` : ""}`;
    case "pack.visit_returned": return `${change.customer.name}: 1 pack visit returned${change.visitsLeftAfter === undefined ? "" : ` (${change.visitsLeftAfter} left)`}`;
    case "booking.created": return `${change.customer.name} booked ${change.session.title} (${change.source})`;
  }
}
export default function SyncPanel({ workspaceId, sync, timezone, onRefresh }: {
  workspaceId: string; sync?: ReturnType<typeof ownerSync>; timezone: string; onRefresh(): unknown;
}) {
  const [visible, setVisible] = useState(false), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/sync`;
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setMessage("Copied."); }
    catch { setMessage("Copy was unavailable. Select and copy the displayed text."); }
  }
  async function acknowledgeAll() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`${path}/ack-all`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not mark changes as applied.");
      setMessage(`${result.acknowledged} changes marked as applied.`); await onRefresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Please retry."); }
    finally { setBusy(false); }
  }
  return <section id="booking-sync" className="customer-replies" aria-labelledby="booking-sync-title" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    <h3 id="booking-sync-title">Booking system sync</h3>
    <p className="muted">Connect your booking system using the sync API. Keep this key private.</p>
    {sync && <><button onClick={() => setVisible(!visible)} aria-expanded={visible} aria-controls="booking-sync-key">{visible ? "Hide key" : "Show key"}</button>
      <div id="booking-sync-key" hidden={!visible}><code>{visible ? sync.key : ""}</code>{visible && <button onClick={() => copy(sync.key)}>Copy key</button>}</div></>}
    <p>Endpoint paths (use this site’s origin):</p><ul>{["changes", "ack", "events"].map((endpoint) => <li key={endpoint}><code>{endpoint === "changes" ? "GET" : "POST"} {path}/{endpoint}</code>
      <button aria-label={`Copy ${endpoint} URL`} onClick={() => copy(`${window.location.origin}${path}/${endpoint}`)}>Copy URL</button></li>)}</ul>
    <p role="status">{sync?.pending ?? 0} pending outbound changes</p>
    <ul>{sync?.recentChanges.map((change) => <li key={change.id}>{changeDescription(change, timezone)}</li>)}</ul>
    <button disabled={busy || !sync?.pending} onClick={acknowledgeAll}>{busy ? "Marking…" : "Mark all as applied"}</button>
    <p className="muted">Mark changes only after applying them in your booking system.</p>
    <p><a href={`/api/workspaces/${workspaceId}/pack-balances`}>Download pack CSV</a>{" · "}<a href={`/api/workspaces/${workspaceId}/pack-balances?pending=1`}>Download pending CSV</a></p>
    <h4>Recent inbound events</h4>
    {sync?.recentEvents.length ? <ul>{sync.recentEvents.map((event) => <li key={event.eventId}>{event.type} · {event.result.status}{event.result.message ? `: ${event.result.message}` : ""}</li>)}</ul> : <p>No inbound events yet.</p>}
    <p role="status">{message}</p>
    <a href="https://github.com/harsha31bs07-blip/rebook/blob/main/docs/sync-api.md" target="_blank" rel="noreferrer">Sync API documentation</a>
  </section>;
}
