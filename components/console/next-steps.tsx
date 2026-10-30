"use client";

import Link from "next/link";
import type { summarizeOutbox } from "../../lib/choices/outbox";
import type { OwnerCover } from "../../lib/recovery/cover-pay";

const COVER = { asked: "hasn’t answered yet", accepted: "accepted", declined: "declined", replaced: "was replaced", withdrawn: "is no longer needed; the regular instructor is back" } as const;
const PAID: Record<string, string> = { REQUESTED: "payout sending", PENDING: "payout processing", SUCCESS: "paid with PayPal", UNCLAIMED: "payout unclaimed", FAILED: "payout failed" };

/** After approval: the three follow-ups that finish a recovery, each with live status and a way to see it. */
export default function NextSteps({ workspaceId, summary, covers, customerPath, onMessages, onPreview }: {
  workspaceId: string; summary?: ReturnType<typeof summarizeOutbox>; covers?: OwnerCover[]; customerPath?: string;
  onMessages: () => void; onPreview: (party: "customer" | "instructor") => void;
}) {
  const total = summary ? summary.sent + summary.notSent : 0;
  const cover = covers?.find((item) => item.current) ?? covers?.[0];
  return <section className="next-steps" aria-labelledby="next-steps-title"><h3 id="next-steps-title">What happens next</h3><ol>
    <li><div><strong>Customers choose</strong><span>{summary ? `${summary.replied} of ${total} replied · ${summary.sent} sent` : "Private links are ready"}</span></div>
      <div className="next-actions"><button onClick={onMessages}>Message customers</button>{customerPath && <button onClick={() => onPreview("customer")}>See a customer’s page</button>}</div></li>
    {cover && <li><div><strong>{cover.instructor} covers {cover.class}</strong><span>{cover.instructor} {COVER[cover.status]}{cover.payout ? ` · ${PAID[cover.payout.status] ?? cover.payout.status.toLowerCase()}` : cover.status === "accepted" ? ` · $${cover.fee} to pay` : ""}</span></div>
      <div className="next-actions"><button onClick={() => onPreview("instructor")}>See {cover.instructor}’s page</button>{cover.status === "accepted" && !cover.payout && <a href="#cover-instructors">Pay with PayPal</a>}</div></li>}
    <li><div><strong>Fill freed seats</strong><span>Waitlist offers and replies</span></div><div className="next-actions"><a href="#waitlist">Open waitlist</a></div></li>
    <li><div><strong>See what Monday cost</strong><span>Dashboard and Recovery analyst</span></div>
      <div className="next-actions"><Link href={`/w/${workspaceId}/dashboard#recovery-analyst`}>Open dashboard</Link></div></li>
  </ol></section>;
}
