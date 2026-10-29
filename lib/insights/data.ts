import type { State } from "../domain/types";
import { localParts, toCents } from "../domain/time";
import { disruptionLabel, weekBounds } from "../client/scheduler-mapping";
import type { CheckoutReservation, Credit, CustomerLink, LedgerEvent, StoredPlan } from "../store";
import { recoveryOutcomes, summarizeRecovery } from "../recovery/outcomes";
import { paymentsNeedingAttention } from "../recovery/payment-attention";

const dollars = (amount: string) => toCents(amount) / 100;

/** Flat, workspace-scoped rows. Never include customer email or provider credentials. */
export function buildInsights(state: State, plans: StoredPlan[], ledger: LedgerEvent[], links: CustomerLink[] = [], credits: Credit[] = [], checkouts: CheckoutReservation[] = []) {
  const applied = plans.filter((plan) => plan.status !== "proposed");
  const creditPaidBookingIds = new Set([...checkouts.filter((row) => row.paidWith === "credit").map((row) => row.id),
    ...credits.flatMap((credit) => credit.redemptions.map((item) => item.bookingId))]);
  const outcomes = recoveryOutcomes(state, plans, ledger, links, creditPaidBookingIds);
  const sessions = new Map(state.sessions.map((session) => [session.id, session]));
  // Execution removes cancellations from the live schedule. Their original records still join bookings.
  for (const plan of applied) for (const session of plan.basis?.sessions ?? []) {
    if (!sessions.has(session.id)) sessions.set(session.id, session);
  }
  const changes = new Map(applied.flatMap((plan) => plan.sessionChanges.map((change) => [change.sessionId, change] as const)));
  const latest = new Map<string, LedgerEvent>();
  for (const event of ledger) latest.set(`${event.kind}:${event.requestId}`, event);
  const choiceLink = (event: LedgerEvent) => event.kind === "refund" ? links.find((link) =>
    link.kind === "choice" && event.requestId === `choice:${link.id}` && event.bookingId === link.bookingId && event.workspaceId === link.workspaceId) : undefined;
  const originatingPlan = (event: LedgerEvent) => {
    const link = choiceLink(event);
    return plans.find((plan) => plan.workspaceId === event.workspaceId && (link ? plan.id === link.planId : event.requestId === `${plan.id}:${event.bookingId}`));
  };
  const moneyEvents = [...latest.values()].filter((event) => event.status !== "MERGED").map((event) => {
    const plan = originatingPlan(event);
    const link = choiceLink(event);
    return {
      id: event.id, kind: event.kind, amount: dollars(event.amount), status: event.status,
      paypal_id: event.paypalId, created_at: event.createdAt, booking_id: event.bookingId,
      plan_id: plan?.id ?? null,
      booking_action_id: plan ? `${plan.id}:${event.bookingId}` : null,
      reason: link ? link.reply?.action === "move" ? "Customer chose a lower-priced class" : "Customer chose a refund"
        : plan?.bookingActions.find((action) => action.bookingId === event.bookingId)?.reason ?? "",
      // Issued money excludes pending/failed requests; simulations remain clearly labelled.
      issued_refund: event.kind === "refund" && ["COMPLETED", "SIMULATED"].includes(event.status) ? dollars(event.amount) : 0,
      payment_mode: event.status === "CREDIT_RESTORED" ? "credit" : event.status === "SIMULATED" ? "simulated" : "real",
      local_day: localParts(event.createdAt, state.studio.timezone).dateKey,
      captured: event.kind === "capture" && ["COMPLETED", "SIMULATED"].includes(event.status) ? dollars(event.amount) : 0,
      net: ["COMPLETED", "SIMULATED"].includes(event.status) ? dollars(event.amount) * (event.kind === "refund" ? -1 : 1) : 0,
    };
  });
  return {
    as_of: new Date().toISOString(),
    recovery_outcomes: outcomes,
    payments_needing_attention: paymentsNeedingAttention(state, ledger),
    covers: plans.flatMap((plan) => plan.sessionChanges.filter((change) => change.remedy === "substitute" && change.after).map((change) => ({
      plan_id: plan.id, status: plan.status, class: sessions.get(change.sessionId)?.title ?? "Class unavailable",
      local_day: localParts(change.before.start, state.studio.timezone).dateKey,
      local_start: localParts(change.before.start, state.studio.timezone).minutesOfDay,
      original_instructor: state.instructors.find((item) => item.id === change.before.instructorId)?.name ?? "Unknown instructor",
      covering_instructor: state.instructors.find((item) => item.id === change.after!.instructorId)?.name ?? "Unknown instructor",
    }))),
    studio: { name: state.studio.name, timezone: state.studio.timezone, currency: state.studio.currency,
      week_start: state.studio.weekStart, week_label: weekBounds(state).label },
    sessions: [...sessions.values()].map((session) => {
      const change = changes.get(session.id);
      const local = localParts(session.start, state.studio.timezone);
      return {
        id: session.id, class_type: session.classType, title: session.title,
        instructor_id: session.instructorId, room_id: session.roomId,
        instructor: state.instructors.find((item) => item.id === session.instructorId)?.name ?? session.instructorId,
        room: state.rooms.find((item) => item.id === session.roomId)?.name ?? session.roomId,
        local_day: local.dateKey,
        local_start: `${String(Math.floor(local.minutesOfDay / 60)).padStart(2, "0")}:${String(Math.floor(local.minutesOfDay % 60)).padStart(2, "0")}`,
        start: session.start, capacity: session.capacity, price: dollars(session.price),
        booked: state.bookings.filter((booking) => booking.sessionId === session.id && ["confirmed", "moved"].includes(booking.status)).length,
        disrupted: Boolean(change),
        status: !change ? "scheduled" : change.remedy === "cancel" ? "cancelled" : change.remedy === "substitute" ? "covered" : "moved",
      };
    }),
    bookings: state.bookings.map((booking) => ({
      id: booking.id, session_id: booking.sessionId, customer_id: booking.customerId,
      status: booking.status, amount: dollars(booking.amount),
      revenue_kept: creditPaidBookingIds.has(booking.id) ? 0 : outcomes.find((item) => item.booking_id === booking.id)?.revenue_kept ??
        (["confirmed", "moved"].includes(booking.status) ? Math.max(0, toCents(booking.amount) - moneyEvents.filter((event) => event.booking_id === booking.id).reduce((sum, event) => sum + Math.round(event.issued_refund * 100), 0)) / 100 : 0),
      payment_mode: creditPaidBookingIds.has(booking.id) ? "credit" : booking.payment?.simulated ? "simulated" : "real",
      capture_id: booking.payment?.captureId ?? "",
    })),
    customers: state.customers.map((customer) => ({ id: customer.id, name: customer.name,
      flexible: customer.prefs.acceptsSubstitute && !customer.prefs.refundOnly,
      loyal_to: (customer.prefs.preferredInstructorIds ?? []).map((id) => state.instructors.find((item) => item.id === id)?.name ?? id).join(", "),
    })),
    instructors: state.instructors.map((instructor) => ({ id: instructor.id, name: instructor.name, skills: instructor.skills.join(", ") })),
    rooms: state.rooms.map((room) => ({ id: room.id, name: room.name, capacity: room.capacity })),
    money_events: moneyEvents,
    credits: credits.map((credit) => ({ id: credit.id, booking_id: credit.bookingId, customer_id: credit.customerId,
      plan_id: links.find((link) => link.id === credit.linkId)?.planId ?? null, amount: dollars(credit.amount), remaining: dollars(credit.remaining),
      redeemed: (credit.redemptions.reduce((sum, item) => sum + toCents(item.amount), 0)
        - (credit.restorations ?? []).reduce((sum, item) => sum + toCents(item.amount), 0)) / 100, status: credit.status, created_at: credit.createdAt })),
    disruptions: plans.map((plan) => {
      const label = disruptionLabel(plan, state);
      const active = plan.status !== "proposed";
      const recovery = summarizeRecovery(outcomes.filter((item) => item.plan_id === plan.id));
      const refunds = [...latest.values()].filter((event) => event.kind === "refund" && originatingPlan(event)?.id === plan.id);
      const amountFor = (statuses: string[]) => refunds.filter((event) => statuses.includes(event.status)).reduce((sum, event) => sum + toCents(event.amount), 0) / 100;
      const plannedAmount = (refund: boolean) => plan.bookingActions.filter((action) => (action.action === "refund") === refund && !creditPaidBookingIds.has(action.bookingId))
        .reduce((sum, action) => sum + toCents(action.amount), 0) / 100;
      return {
        id: plan.id, kind: plan.disruption.kind, subject: label.subject, window: label.window, label: `${label.subject}, ${label.window}`,
        status: plan.status, sessions_affected: plan.totals.sessionsAffected,
        kept: active ? recovery.kept : plan.totals.kept, moved: active ? recovery.moved : plan.totals.moved, refunded: active ? recovery.refunded : plan.totals.refunded,
        pending: recovery.pending, no_reply: recovery.noReply, simulated_refunded: recovery.simulatedRefunded,
        credited: recovery.credited, kept_as_credit: recovery.keptAsCredit,
        refund_amount: plannedAmount(true), revenue_kept: active ? recovery.revenueKept : plannedAmount(false),
        planned_refund_amount: plannedAmount(true),
        pending_refund_amount: amountFor(["REQUESTED", "PENDING", "UNKNOWN", "NEEDS_REVIEW"]),
        completed_refund_amount: amountFor(["COMPLETED"]),
        simulated_refund_amount: amountFor(["SIMULATED"]),
        failed_refund_amount: amountFor(["FAILED", "CANCELLED"]),
        affected: plan.totals.kept + plan.totals.moved + plan.totals.refunded,
        applied_affected: recovery.affected,
        applied_saved: recovery.saved,
        applied_kept: recovery.kept,
        applied_moved: recovery.moved,
        applied_refunded: recovery.refunded,
        applied_revenue_kept: recovery.revenueKept,
        created_at: plan.createdAt,
        covers: plan.sessionChanges.filter((change) => change.remedy === "substitute").map((change) => {
          const name = (id: string) => state.instructors.find((item) => item.id === id)?.name ?? id;
          const session = change.before;
          const local = localParts(session.start, state.studio.timezone);
          const time = `${String(Math.floor(local.minutesOfDay / 60)).padStart(2, "0")}:${String(local.minutesOfDay % 60).padStart(2, "0")}`;
          return `${name(change.after!.instructorId)} covered ${name(change.before.instructorId)} for ${sessions.get(change.sessionId)?.title ?? "Class"}, ${local.dateKey} at ${time}`;
        }).join("; "),
      };
    }),
    booking_actions: plans.flatMap((plan) => plan.bookingActions.map((action) => ({
      id: `${plan.id}:${action.bookingId}`, plan_id: plan.id, booking_id: action.bookingId,
      action: action.action, reason: action.reason, amount: dollars(action.amount),
    }))),
    notes: ["USD amounts include clearly labelled simulated sandbox payments. Planned refunds are forecasts. Completed disruption cost includes completed plan refunds and customer-choice refunds attributed to that plan; pending, failed and simulated refunds are labelled separately. Recovery KPIs count each booking once under its latest applied plan, using replies and settled refunds across its history. Studio credits retain captured revenue, release the original seat and are reported separately from refunds. Redeeming credit does not create another capture or count the retained revenue again. Kept or moved means the booking is confirmed; No reply yet separately tracks customer confirmation. Pending includes refunds requested or awaiting PayPal, including price differences for moved bookings. Revenue kept subtracts settled refunds; bookings requesting a full refund are excluded."],
  };
}

export type Insights = ReturnType<typeof buildInsights>;
