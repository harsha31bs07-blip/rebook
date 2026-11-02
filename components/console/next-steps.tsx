"use client";

import Link from "next/link";
import type { summarizeOutbox } from "../../lib/choices/outbox";
import { activeCovers, coverLine, coverNeedsOwner, coverSettled } from "../../lib/recovery/completion";
import type { OwnerCover } from "../../lib/recovery/cover-pay";

/** After approval: only the follow-ups this recovery actually has, with anything needing the owner first. */
export default function NextSteps({ workspaceId, summary, covers, customerPath, day, showWaitlist, showSync, onMessages, onPreview }: {
  workspaceId: string; summary?: ReturnType<typeof summarizeOutbox>; covers?: OwnerCover[]; customerPath?: string; day?: string;
  showWaitlist?: boolean; showSync?: boolean;
  onMessages: () => void; onPreview: (party: "customer" | "instructor") => void;
}) {
  const total = summary ? summary.sent + summary.notSent : 0;
  const active = activeCovers(covers);
  const previewable = active.find((cover) => cover.current && cover.status !== "declined");
  const coverStep = (cover: OwnerCover) => <li key={`${cover.planId}-${cover.sessionId}-${cover.instructorId}`}><div><strong>{cover.current && cover.status === "declined" ? `${cover.class} needs a new instructor` : `${cover.instructor} covers ${cover.class}`}</strong><span>{coverLine(cover)}</span></div>
    <div className="next-actions">{cover === previewable && <button onClick={() => onPreview("instructor")}>See {cover.instructor}’s page</button>}{coverNeedsOwner(cover) && <a href="#cover-instructors">{cover.status === "accepted" && !cover.payout ? "Pay with PayPal" : cover.status === "declined" && cover.next ? `Ask ${cover.next}` : "Open cover pay"}</a>}</div></li>;
  return <section className="next-steps" aria-labelledby="next-steps-title"><h3 id="next-steps-title">What happens next</h3><ol>
    {active.filter(coverNeedsOwner).map(coverStep)}
    <li><div><strong>Customers choose</strong><span>{summary ? `${summary.replied} of ${summary.needsReply} replied · ${summary.sent} of ${total} messages sent` : "Private links are ready"}</span></div>
      <div className="next-actions"><button className="primary" onClick={onMessages}>Message customers</button>{customerPath && <button onClick={() => onPreview("customer")}>See a customer’s page</button>}</div></li>
    {active.filter((cover) => !coverNeedsOwner(cover) && !coverSettled(cover)).map(coverStep)}
    {showWaitlist && <li><div><strong>Fill freed seats</strong><span>Waitlist offers and replies</span></div><div className="next-actions"><a href="#waitlist">Open waitlist</a></div></li>}
    {showSync && <li><div><strong>Update your booking system</strong><span>Changes and incoming bookings</span></div><div className="next-actions"><a href="#booking-sync">Open booking sync</a></div></li>}
    {active.filter(coverSettled).map(coverStep)}
    <li><div><strong>See what {day ?? "this recovery"} cost</strong><span>Dashboard and Recovery analyst</span></div>
      <div className="next-actions"><Link href={`/w/${workspaceId}/dashboard#recovery-analyst`}>Open dashboard</Link></div></li>
  </ol></section>;
}
