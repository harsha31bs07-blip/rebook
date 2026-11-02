"use client";

import { useState } from "react";
import { api } from "../../lib/client/api";
import type { OwnerCover } from "../../lib/recovery/cover-pay";
import { describePayRule } from "../../lib/recovery/pay-rules";

const STATUS = { asked: "Asked", accepted: "Accepted", declined: "Declined", replaced: "Replaced by a later change", withdrawn: "Back with the regular instructor" } as const;
const PAYOUT: Record<string, string> = { REQUESTED: "Sending to PayPal", PENDING: "Processing with PayPal", SUCCESS: "Paid", UNCLAIMED: "Unclaimed",
  ONHOLD: "On hold", FAILED: "Failed", RETURNED: "Returned", BLOCKED: "Blocked", REFUNDED: "Refunded", REVERSED: "Reversed", DENIED: "Declined" };

/** Substitutes accept on their own link; the owner then pays the cover fee with PayPal Payouts. */
export default function CoverPay({ workspaceId, covers, onUpdated }: { workspaceId: string; covers?: OwnerCover[]; onUpdated: () => void }) {
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<{ path: string; perClass: string; perAttendee: string; cap: string }>();
  const [ruleError, setRuleError] = useState("");
  if (!covers?.length) return null;
  async function pay(cover: OwnerCover) {
    setBusy(cover.sessionId); setNotice("");
    try { await api.payCover(workspaceId, cover.planId, cover.sessionId); setNotice(`PayPal accepted ${cover.instructor}’s $${cover.fee} payout. Status updates here.`); onUpdated(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Unable to pay this cover."); onUpdated(); }
    finally { setBusy(""); }
  }
  async function askNext(cover: OwnerCover) {
    setBusy(cover.sessionId); setNotice("");
    try { await api.askNextCover(workspaceId, cover.planId, cover.sessionId); setNotice(`Asked ${cover.next} to cover ${cover.class}. Customers' pages now show ${cover.next}.`); onUpdated(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Unable to ask another instructor."); onUpdated(); }
    finally { setBusy(""); }
  }
  async function copy(cover: OwnerCover) {
    try { await navigator.clipboard.writeText(new URL(cover.path, window.location.origin).href); setNotice(`Copied ${cover.instructor}’s cover link.`); }
    catch { setNotice("Copy failed. Open the link and copy it from the address bar."); }
  }
  async function saveRule(cover: OwnerCover, reset = false) {
    if (!editor) return;
    setBusy(cover.sessionId); setRuleError("");
    try {
      await api.instructorPay(workspaceId, cover.instructorId, reset ? { reset: true } : { perClass: Number(editor.perClass).toFixed(2),
        ...(editor.perAttendee !== "" ? { perAttendee: Number(editor.perAttendee).toFixed(2) } : {}), ...(editor.cap !== "" ? { cap: Number(editor.cap).toFixed(2) } : {}) });
      setEditor(undefined); setNotice(`Updated ${cover.instructor}’s pay rule.`); onUpdated();
    } catch (error) { setRuleError(error instanceof Error ? error.message : "Unable to save this pay rule."); }
    finally { setBusy(""); }
  }
  return <section id="cover-instructors" className="refund-results cover-pay" aria-label="Cover instructors"><h3>Cover instructors</h3>
    {covers.map((cover, index) => {
      const payable = cover.status === "accepted" && cover.payee && (!cover.payout || ["REQUESTED", "FAILED", "RETURNED", "BLOCKED", "DENIED", "REFUNDED", "REVERSED"].includes(cover.payout.status));
      const editable = !cover.payout || cover.payout.status === "FAILED";
      return <div className="refund-row" key={`${cover.planId}:${cover.sessionId}:${index}`}>
        <div><strong>{cover.instructor} covers {cover.class} · {cover.when}</strong><span className="result-status">{STATUS[cover.status]}{cover.respondedBy === "owner" ? " by you" : ""}</span></div>
        <p className="muted">For {cover.original} · ${cover.fee} cover fee{cover.payout ? ` · ${PAYOUT[cover.payout.status] ?? cover.payout.status}` : ""}{cover.payout?.itemId ? ` · ${cover.payout.itemId}` : ""}</p>
        <p className="muted">{describePayRule(cover.rule)}{cover.rule.perAttendee !== undefined && editable ? ` · ${cover.attendees} booked → $${cover.fee}` : ""}{cover.estimate ? " · Estimate — final after the class" : ""}</p>
        {cover.status === "withdrawn" && <p className="muted">The disruption was withdrawn; this class went back to its regular instructor.{cover.payout ? " The existing payout stays recorded." : " This cover can no longer be accepted or paid."}</p>}
        {cover.status === "declined" && cover.current && (cover.next
          ? <p className="warning">{cover.instructor} declined. {cover.next} is qualified, free then and suits everyone booked.</p>
          : <p className="warning">{cover.instructor} declined{cover.next === null ? " and no other qualified instructor is free then" : ""}. Plan a new recovery for this class.</p>)}
        {cover.payout?.error && <p className="error">{cover.payout.error}</p>}
        {(cover.current !== false || editable) && <div className="button-row">
          {cover.current !== false && <><a href={cover.path} target="_blank" rel="noopener noreferrer" aria-label={`Open ${cover.instructor}’s cover link`}>Open cover link</a>
            <button onClick={() => void copy(cover)} aria-label={`Copy ${cover.instructor}’s cover link`}>Copy link</button></>}
          {editable && <button disabled={!!busy} aria-expanded={editor?.path === cover.path} onClick={() => { setRuleError(""); setEditor({ path: cover.path, perClass: cover.rule.perClass, perAttendee: cover.rule.perAttendee ?? "", cap: cover.rule.cap ?? "" }); }}>Pay rule</button>}
          {cover.status === "declined" && cover.current && cover.next && <button className="primary" disabled={!!busy} onClick={() => void askNext(cover)}>{busy === cover.sessionId ? `Asking ${cover.next}…` : `Ask ${cover.next} instead`}</button>}
          {cover.current !== false && payable && <button className="primary" disabled={!!busy} onClick={() => void pay(cover)}>{busy === cover.sessionId ? "Paying with PayPal…" : cover.payout?.status === "REQUESTED" ? `Check payout to ${cover.instructor}` : `Pay ${cover.instructor} ${cover.fee} with PayPal`}</button>}
        </div>}
        {editable && editor?.path === cover.path && <form className="cover-pay-rule" aria-label={`Pay rule for ${cover.instructor}`} onSubmit={(event) => { event.preventDefault(); void saveRule(cover); }}>
          <p className="muted">Applies to {cover.instructor}’s unpaid covers.</p>
          {([["perClass", "Per class"], ["perAttendee", "Per attendee (optional)"], ["cap", "Cap (optional)"]] as const).map(([field, label]) => <label key={field}>{label}
            <input type="number" inputMode="decimal" min="0" max="500" step="0.01" required={field === "perClass"} value={editor[field]} disabled={!!busy}
              onChange={(event) => setEditor({ ...editor, [field]: event.target.value })} /></label>)}
          <div className="button-row"><button className="primary" type="submit" disabled={!!busy}>{busy ? "Saving…" : "Save"}</button>
            <button type="button" disabled={!!busy} onClick={() => void saveRule(cover, true)}>Use studio default</button>
            <button type="button" disabled={!!busy} onClick={() => { setEditor(undefined); setRuleError(""); }}>Cancel</button></div>
          {ruleError && <p className="error" role="status">{ruleError}</p>}
        </form>}
        {cover.status === "accepted" && !cover.payout && <p className="muted">Studios usually pay after the class; you choose when.</p>}
        {cover.status === "accepted" && !cover.payee && <p className="muted">Payouts need a sandbox payee configured on the server.</p>}
      </div>;
    })}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
