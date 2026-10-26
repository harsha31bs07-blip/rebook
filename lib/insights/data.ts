import type { State } from "../domain/types";
import { localParts, toCents } from "../domain/time";
import { disruptionLabel, weekBounds } from "../client/scheduler-mapping";
import type { CustomerLink, LedgerEvent, StoredPlan } from "../store";

const dollars = (amount: string) => toCents(amount) / 100;

/** Flat, workspace-scoped rows. Never include customer email or provider credentials. */
export function buildInsights(state: State, plans: StoredPlan[], ledger: LedgerEvent[], links: CustomerLink[] = []) {
  const applied = plans.filter((plan) => plan.status !== "proposed");
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
      payment_mode: event.status === "SIMULATED" ? "simulated" : "real",
      local_day: localParts(event.createdAt, state.studio.timezone).dateKey,
      captured: event.kind === "capture" && ["COMPLETED", "SIMULATED"].includes(event.status) ? dollars(event.amount) : 0,
      net: ["COMPLETED", "SIMULATED"].includes(event.status) ? dollars(event.amount) * (event.kind === "refund" ? -1 : 1) : 0,
    };
  });
  return {
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
      payment_mode: booking.payment?.simulated ? "simulated" : "real",
      capture_id: booking.payment?.captureId ?? "",
    })),
    customers: state.customers.map((customer) => ({ id: customer.id, name: customer.name,
      flexible: customer.prefs.acceptsSubstitute && !customer.prefs.refundOnly,
      loyal_to: (customer.prefs.preferredInstructorIds ?? []).map((id) => state.instructors.find((item) => item.id === id)?.name ?? id).join(", "),
    })),
    instructors: state.instructors.map((instructor) => ({ id: instructor.id, name: instructor.name, skills: instructor.skills.join(", ") })),
    rooms: state.rooms.map((room) => ({ id: room.id, name: room.name, capacity: room.capacity })),
    money_events: moneyEvents,
    disruptions: plans.map((plan) => {
      const label = disruptionLabel(plan, state);
      const active = plan.status !== "proposed";
      const refunds = [...latest.values()].filter((event) => event.kind === "refund" && originatingPlan(event)?.id === plan.id);
      const amountFor = (statuses: string[]) => refunds.filter((event) => statuses.includes(event.status)).reduce((sum, event) => sum + toCents(event.amount), 0) / 100;
      return {
        id: plan.id, kind: plan.disruption.kind, subject: label.subject, window: label.window,
        status: plan.status, sessions_affected: plan.totals.sessionsAffected,
        kept: plan.totals.kept, moved: plan.totals.moved, refunded: plan.totals.refunded,
        refund_amount: dollars(plan.totals.refundAmount), revenue_kept: dollars(plan.totals.revenueKept),
        planned_refund_amount: dollars(plan.totals.refundAmount),
        pending_refund_amount: amountFor(["REQUESTED", "PENDING"]),
        completed_refund_amount: amountFor(["COMPLETED"]),
        simulated_refund_amount: amountFor(["SIMULATED"]),
        failed_refund_amount: amountFor(["FAILED", "CANCELLED"]),
        affected: plan.totals.kept + plan.totals.moved + plan.totals.refunded,
        applied_affected: active ? plan.totals.kept + plan.totals.moved + plan.totals.refunded : 0,
        applied_saved: active ? plan.totals.kept + plan.totals.moved : 0,
        applied_revenue_kept: active ? dollars(plan.totals.revenueKept) : 0,
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
    notes: ["USD amounts include clearly labelled simulated sandbox payments. Planned refunds are forecasts. Completed disruption cost includes completed plan refunds and customer-choice refunds attributed to that plan; pending, failed and simulated refunds are labelled separately. Overview recovery KPIs include applied plans only. Refund totals use the latest status per request. Revenue kept measures recovery interventions, so repeat disruptions can count a booking again."],
  };
}

export type Insights = ReturnType<typeof buildInsights>;
