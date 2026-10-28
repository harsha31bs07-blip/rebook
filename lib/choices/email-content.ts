import type { CheckoutReservation } from "../store";
import { outboxMessage, type OutboxCustomer } from "./outbox";

export function deliverableAddress(email: string, bookingIds: string[], checkouts: CheckoutReservation[]): boolean {
  const address = email.trim().toLowerCase(), domain = address.split("@")[1];
  return !!domain && !["example.com", "test", "invalid", "localhost"].some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`))
    && checkouts.some((row) => row.status === "confirmed" && bookingIds.includes(row.id) && row.customer.email.trim().toLowerCase() === address);
}
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
export function outboxEmail(row: OutboxCustomer, studio: string, origin: string, reminder = false) {
  const footer = "Sent from the Rebook demo (PayPal sandbox; no real money moves).";
  const subject = `${reminder ? "Reminder: " : ""}${row.changes[0].subject}`;
  const text = `${outboxMessage(row, origin, reminder)}\n\n${footer}`;
  const privateUrls = [...new Set(row.changes.filter((change) => change.path).map((change) => escapeHtml(new URL(change.path!, origin).href)))];
  const paragraphs = text.split("\n\n").map((paragraph) => {
    let html = escapeHtml(paragraph).replace(/\n/g, "<br>");
    for (const url of privateUrls) html = html.replaceAll(url, () => `<a href="${url}">${url}</a>`);
    return `<p>${html}</p>`;
  }).join("");
  return { subject, text, html: `<!doctype html><html lang="en"><body><h1>${escapeHtml(studio)}</h1>${paragraphs}</body></html>`, senderName: `${studio} via Rebook` };
}
