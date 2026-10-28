"use client";

import { useState } from "react";
import { api } from "../../lib/client/api";
import type { OwnerCover } from "../../lib/recovery/cover-pay";

const STATUS = { asked: "Asked", accepted: "Accepted", declined: "Declined", replaced: "Replaced by a later change" } as const;
const PAYOUT: Record<string, string> = { REQUESTED: "Sending to PayPal", PENDING: "Processing with PayPal", SUCCESS: "Paid", UNCLAIMED: "Unclaimed",
  ONHOLD: "On hold", FAILED: "Failed", RETURNED: "Returned", BLOCKED: "Blocked", REFUNDED: "Refunded", REVERSED: "Reversed", DENIED: "Declined" };

/** Substitutes accept on their own link; the owner then pays the cover fee with PayPal Payouts. */
export default function CoverPay({ workspaceId, covers, onUpdated }: { workspaceId: string; covers?: OwnerCover[]; onUpdated: () => void }) {
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  if (!covers?.length) return null;
  async function pay(cover: OwnerCover) {
    setBusy(cover.sessionId); setNotice("");
    try { await api.payCover(workspaceId, cover.planId, cover.sessionId); setNotice(`PayPal accepted ${cover.instructor}’s $${cover.fee} payout. Status updates here.`); onUpdated(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Unable to pay this cover."); onUpdated(); }
    finally { setBusy(""); }
  }
  async function copy(cover: OwnerCover) {
    try { await navigator.clipboard.writeText(new URL(cover.path, window.location.origin).href); setNotice(`Copied ${cover.instructor}’s cover link.`); }
    catch { setNotice("Copy failed. Open the link and copy it from the address bar."); }
  }
  return <section className="refund-results cover-pay" aria-label="Cover instructors"><h3>Cover instructors</h3>
    {covers.map((cover) => {
      const payable = cover.status === "accepted" && cover.payee && (!cover.payout || ["REQUESTED", "FAILED", "RETURNED", "BLOCKED", "DENIED", "REFUNDED", "REVERSED"].includes(cover.payout.status));
      return <div className="refund-row" key={`${cover.planId}:${cover.sessionId}`}>
        <div><strong>{cover.instructor} covers {cover.class} · {cover.when}</strong><span className="result-status">{STATUS[cover.status]}{cover.respondedBy === "owner" ? " by you" : ""}</span></div>
        <p className="muted">For {cover.original} · ${cover.fee} cover fee{cover.payout ? ` · ${PAYOUT[cover.payout.status] ?? cover.payout.status}` : ""}{cover.payout?.itemId ? ` · ${cover.payout.itemId}` : ""}</p>
        {cover.status === "declined" && <p className="warning">{cover.instructor} declined. Plan a new recovery for this class.</p>}
        {cover.payout?.error && <p className="error">{cover.payout.error}</p>}
        <div className="button-row">
          <a href={cover.path} target="_blank" rel="noopener noreferrer" aria-label={`Open ${cover.instructor}’s cover link`}>Open cover link</a>
          <button onClick={() => void copy(cover)} aria-label={`Copy ${cover.instructor}’s cover link`}>Copy link</button>
          {payable && <button className="primary" disabled={!!busy} onClick={() => void pay(cover)}>{busy === cover.sessionId ? "Paying with PayPal…" : cover.payout?.status === "REQUESTED" ? `Check payout to ${cover.instructor}` : `Pay ${cover.instructor} $${cover.fee} with PayPal`}</button>}
        </div>
        {cover.status === "accepted" && !cover.payout && <p className="muted">Studios usually pay after the class; you choose when.</p>}
        {cover.status === "accepted" && !cover.payee && <p className="muted">Payouts need a sandbox payee configured on the server.</p>}
      </div>;
    })}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
