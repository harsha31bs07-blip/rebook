import type { Insights } from "./data";
import { summarizeRecovery } from "../recovery/outcomes";
import { localTimeLabel, titleCase } from "./formatting";

export type RefundGroup = "reason" | "class" | "status";
export type RevenueGroup = "class_type" | "instructor" | "day";
const money = (values: number[]) => values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;
const stamp = (data: Insights) => ({ asOf: data.as_of, timezone: data.studio.timezone, currency: data.studio.currency, scope: "Loaded workspace week; independent of report filters" });

export function getRecoverySummary(data: Insights) {
  return { ...stamp(data), ...summarizeRecovery(data.recovery_outcomes),
    disruptions: data.disruptions.map((plan) => ({ disruption: `${plan.subject}, ${plan.window}`, status: plan.status,
      ...summarizeRecovery(data.recovery_outcomes.filter((row) => row.plan_id === plan.id)),
      completedRefundAmount: plan.completed_refund_amount, simulatedRefundAmount: plan.simulated_refund_amount,
      pendingRefundUSD: plan.pending_refund_amount, failedRefundUSD: plan.failed_refund_amount,
      plannedRefundUSD: plan.planned_refund_amount,
    })), note: "Applied outcomes count each booking once under its latest applied plan. Per-disruption refund money follows the originating plan. No reply overlaps kept/moved; pending may include a moved booking's price difference. Simulated refunds are separate. Proposed plans are forecasts only." };
}

export function getRefundBreakdown(data: Insights, groupBy: RefundGroup = "reason") {
  const groups = new Map<string, Insights["money_events"]>();
  for (const event of data.money_events.filter((row) => row.kind === "refund")) {
    const booking = data.bookings.find((row) => row.id === event.booking_id);
    const session = data.sessions.find((row) => row.id === booking?.session_id);
    const label = groupBy === "reason" ? event.reason || "Unspecified reason" : groupBy === "status" ? titleCase(event.status)
      : session ? `${session.title}, ${session.local_day} at ${localTimeLabel(session.local_start)}` : "Class unavailable";
    groups.set(label, [...(groups.get(label) ?? []), event]);
  }
  return { ...stamp(data), groupBy, rows: [...groups].map(([label, events]) => ({ label, requests: events.length,
    completedUSD: money(events.filter((row) => row.status === "COMPLETED").map((row) => row.amount)),
    simulatedUSD: money(events.filter((row) => row.status === "SIMULATED").map((row) => row.amount)),
    pendingUSD: money(events.filter((row) => ["REQUESTED", "PENDING", "UNKNOWN", "NEEDS_REVIEW"].includes(row.status)).map((row) => row.amount)),
    failedUSD: money(events.filter((row) => ["FAILED", "CANCELLED"].includes(row.status)).map((row) => row.amount)),
  })).sort((a, b) => b.completedUSD + b.simulatedUSD - a.completedUSD - a.simulatedUSD || a.label.localeCompare(b.label)),
  note: "Latest receipt per request, including customer-choice refunds. Requests are not unique bookings. Completed and simulated amounts are separate; pending/failed amounts are not issued refunds." };
}

export function getRevenueBreakdown(data: Insights, groupBy: RevenueGroup = "class_type") {
  const groups = new Map<string, Insights["bookings"]>();
  for (const booking of data.bookings) {
    const session = data.sessions.find((row) => row.id === booking.session_id);
    const label = !session ? "Class unavailable" : groupBy === "day" ? session.local_day : groupBy === "instructor" ? session.instructor : session.class_type === "hiit" ? "HIIT" : titleCase(session.class_type);
    groups.set(label, [...(groups.get(label) ?? []), booking]);
  }
  const rows = [...groups].map(([label, bookings]) => ({ label, bookings: bookings.length,
    bookedUSD: money(bookings.map((row) => row.amount)), keptUSD: money(bookings.map((row) => row.revenue_kept)),
  }));
  rows.sort((a, b) => groupBy === "day" ? a.label.localeCompare(b.label) : b.keptUSD - a.keptUSD || a.label.localeCompare(b.label));
  return { ...stamp(data), groupBy, rows, note: "Booked is the recorded booking amount across all statuses. Kept includes unaffected confirmed bookings and shared applied recovery outcomes, less settled refunds. Grouped by the current class/instructor/day. Simulated payments included." };
}

export function getCoverSummary(data: Insights) {
  return { ...stamp(data), rows: data.covers.map((row) => ({ class: row.class, day: row.local_day,
    time: localTimeLabel(`${String(Math.floor(row.local_start / 60)).padStart(2, "0")}:${String(row.local_start % 60).padStart(2, "0")}`),
    originalInstructor: row.original_instructor, coveringInstructor: row.covering_instructor, status: row.status,
  })), note: "Proposed cover is a forecast. Each row is a class substitution recorded in a disruption plan; repeated plans can describe the same class." };
}
