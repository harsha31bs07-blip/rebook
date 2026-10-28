import type { CustomerMessage } from "../ai/messages";

export type OutboxChange = {
  bookingId: string; subject: string; body: string;
  kind?: "choice" | "receipt"; path?: string; expiresAt?: number;
  sentAt?: string; reply?: { status: "kept" | "moved" | "chose another class" | "refund requested" | "refunded"; at: string };
};
export type OutboxCustomer = {
  customerId: string; customerName: string; planId: string; changes: OutboxChange[];
};

export function outboxState(row: OutboxCustomer) {
  const choices = row.changes.filter((change) => change.kind === "choice");
  const replied = choices.length > 0 && choices.every((change) => change.reply);
  const sent = row.changes.every((change) => change.sentAt);
  return { sent, replied, waiting: sent && choices.some((change) => !change.reply),
    sentAt: sent ? row.changes.map((change) => change.sentAt!).sort().at(-1) : undefined };
}

export function summarizeOutbox(rows: OutboxCustomer[]) {
  const states = rows.map(outboxState);
  return { sent: states.filter((state) => state.sent).length, replied: states.filter((state) => state.replied).length,
    waiting: states.filter((state) => state.waiting).length, notSent: states.filter((state) => !state.sent).length };
}

export function waitingCustomers(rows: OutboxCustomer[]) { return rows.filter((row) => outboxState(row).waiting); }

/** Preview rows have no delivery status until approval creates durable private links. */
export function draftOutbox(messages: CustomerMessage[], links: { bookingId: string; planId: string; kind: "choice" | "receipt"; path: string; expiresAt: number }[] = []) {
  const rows = new Map<string, OutboxCustomer>();
  for (const message of messages.toSorted((a, b) => Number(links.find((link) => link.bookingId === b.bookingId)?.kind === "choice") - Number(links.find((link) => link.bookingId === a.bookingId)?.kind === "choice"))) {
    const link = links.find((item) => item.bookingId === message.bookingId);
    const row = rows.get(message.customerId) ?? { customerId: message.customerId, customerName: message.customerName ?? "Customer", planId: link?.planId ?? "", changes: [] };
    row.changes.push({ ...message, ...link }); rows.set(message.customerId, row);
  }
  return [...rows.values()];
}

export function outboxMessage(row: OutboxCustomer, origin?: string, reminder = false) {
  const changes = reminder ? row.changes.filter((change) => change.kind === "choice" && !change.reply) : row.changes;
  const path = (change: OutboxChange) => origin ? new URL(change.path!, origin).href : change.path;
  if (reminder) return `Hi ${row.customerName}, just a reminder to choose what works for your updated class${changes.length === 1 ? "" : "es"}:\n${changes.map((change) => `${change.subject}\n${path(change)}`).join("\n\n")}\n\nThank you!`;
  return changes.map((change) => `${change.body.replace("Doesn't work? Reply for a refund.", "Use your private link to keep your new time, find another class, or take a refund.")}\n\n${change.kind === "receipt" ? "Refund receipt" : "Private choice link"}: ${path(change)}`).join("\n\n");
}

export function messageDeepLinks(subject: string, body: string) {
  const text = encodeURIComponent(body);
  return { whatsapp: `https://wa.me/?text=${text}`, sms: `sms:?&body=${text}`, email: `mailto:?subject=${encodeURIComponent(subject)}&body=${text}` };
}
