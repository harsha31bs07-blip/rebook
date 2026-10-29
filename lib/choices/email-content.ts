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
export type CreditEmailInput = { studio: string; customerName: string; amount: string; url: string; className: string; classStart: string; timezone: string };
/** A plain, table-based layout with inline styles, which renders the same in Gmail, Outlook and Apple Mail. */
export function creditEmail({ studio, customerName, amount, url, className, classStart, timezone }: CreditEmailInput) {
  const when = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(classStart));
  const firstName = customerName.trim().split(/\s+/)[0] || "there";
  const intro = `You chose to keep your payment for ${className} (${when}) as studio credit after the class changed. You can use it to book any class at ${studio}.`;
  const care = "Your credit doesn't expire. This button is personal to you, so please don't forward this email.";
  const why = `You're receiving this because you booked a class at ${studio}. Sent through Rebook (a PayPal sandbox demo; no real money moves).`;
  const text = [`Hi ${firstName},`, intro, `Studio credit: $${amount}`, `Redeem your credit: ${url}`, care, why].join("\n\n");
  const e = escapeHtml, font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(`Your studio credit at ${studio}`)}</title></head>`
    + `<body style="margin:0;padding:0;background:#f4f5f7;">`
    + `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${e(`Your $${amount} credit is ready to use on any class.`)}</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;"><tr><td align="center" style="padding:32px 16px;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e3e6ea;border-radius:12px;">`
    + `<tr><td style="padding:28px 32px 0;${font}font-size:16px;font-weight:600;color:#111827;">${e(studio)}</td></tr>`
    + `<tr><td style="padding:24px 32px 0;${font}font-size:15px;line-height:24px;color:#374151;">Hi ${e(firstName)},</td></tr>`
    + `<tr><td style="padding:12px 32px 0;${font}font-size:15px;line-height:24px;color:#374151;">${e(intro)}</td></tr>`
    + `<tr><td style="padding:24px 32px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e3e6ea;border-radius:10px;">`
    + `<tr><td style="padding:18px 20px 4px;${font}font-size:13px;color:#6b7280;">Studio credit</td></tr>`
    + `<tr><td style="padding:0 20px 18px;${font}font-size:30px;line-height:36px;font-weight:700;color:#111827;">$${e(amount)}</td></tr></table></td></tr>`
    + `<tr><td align="left" style="padding:24px 32px 0;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>`
    + `<td style="background:#1d4ed8;border-radius:8px;"><a href="${e(url)}" style="display:inline-block;padding:13px 26px;${font}font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">Redeem your credit</a></td>`
    + `</tr></table></td></tr>`
    + `<tr><td style="padding:20px 32px 28px;${font}font-size:13px;line-height:20px;color:#6b7280;">${e(care)}</td></tr>`
    + `</table>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;"><tr><td style="padding:16px 32px 0;${font}font-size:12px;line-height:18px;color:#9ca3af;">${e(why)}</td></tr></table>`
    + `</td></tr></table></body></html>`;
  return { subject: `Your $${amount} studio credit at ${studio}`, text, html, senderName: `${studio} via Rebook` };
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
