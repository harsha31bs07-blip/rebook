import type { Plan, State } from "../domain/types";

export type CustomerMessage = { bookingId: string; customerId: string; customerName?: string; subject: string; body: string };

/** Drafts only: sending and refund execution belong to the approval flow. No AI or network calls. */
export function draftCustomerMessages(plan: Plan, state: State): CustomerMessage[] {
  const formatTime = (instant: string) => new Intl.DateTimeFormat("en-US", {
    timeZone: state.studio.timezone, weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(instant));
  return plan.bookingActions.map((action) => {
    const booking = state.bookings.find((item) => item.id === action.bookingId);
    const customer = state.customers.find((item) => item.id === action.customerId);
    const session = state.sessions.find((item) => item.id === booking?.sessionId);
    if (!booking || !customer || !session) throw new Error(`Cannot draft message for booking ${action.bookingId}: missing booking, customer, or session`);
    const change = plan.sessionChanges.find((item) => item.sessionId === session.id);
    const greeting = `Hi ${customer.name},`;
    const signature = `Thank you for being part of ${state.studio.name}.`;
    let subject: string;
    let body: string;
    if (action.action === "refund") {
      subject = `A refund for your ${session.title} booking`;
      body = `${greeting}\n\nWe're sorry we couldn't keep your ${session.title} booking. We'll arrange a refund of ${state.studio.currency} ${action.amount}. ${action.reason}\n\n${signature}`;
    } else if (action.action === "move") {
      if (!change?.after) throw new Error(`Cannot draft moved booking ${action.bookingId}: missing replacement placement`);
      subject = `Your new time for ${session.title}`;
      body = `${greeting}\n\nWe've found a new time for your ${session.title} class: ${formatTime(change.after.start)} (${state.studio.timezone}). We're sorry for the change and look forward to seeing you.\n\nDoesn't work? Reply for a refund.\n\n${signature}`;
    } else {
      const instructorId = change?.after?.instructorId ?? session.instructorId;
      const instructor = state.instructors.find((item) => item.id === instructorId);
      const instructorChanged = instructorId !== (change?.before.instructorId ?? session.instructorId);
      const roomChanged = change?.after && change.after.roomId !== change.before.roomId;
      const room = state.rooms.find((item) => item.id === change?.after?.roomId);
      subject = `An update to your ${session.title} class`;
      const update = instructorChanged
        ? `${instructor?.name ?? "A qualified substitute"} will be teaching your class.`
        : roomChanged ? `Your class will take place in ${room?.name ?? "a replacement room"}.` : "Your booking is confirmed.";
      body = `${greeting}\n\n${update} Your ${session.title} class stays at ${formatTime(change?.after?.start ?? session.start)} (${state.studio.timezone}). We're looking forward to welcoming you.\n\n${signature}`;
    }
    return { bookingId: action.bookingId, customerId: action.customerId, customerName: customer.name, subject, body };
  });
}
