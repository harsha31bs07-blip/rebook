export type EmailInput = { to: string; name: string; subject: string; text: string; html: string; tags: string[]; senderName?: string };
export type EmailResult = { kind: "accepted"; messageId: string } | { kind: "rejected"; reason: string } | { kind: "unknown" };
export type EmailStatus = "sent" | "delivered" | "bounced" | "deferred";
export function emailConfigured(): boolean { return !!process.env.BREVO_API_KEY?.trim() && !!process.env.BREVO_SENDER_EMAIL?.trim(); }

export async function sendEmail(input: EmailInput): Promise<EmailResult> {
  if (!emailConfigured()) return { kind: "rejected", reason: "Email delivery is not configured." };
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST", headers: { "api-key": process.env.BREVO_API_KEY!, "content-type": "application/json" },
      body: JSON.stringify({ sender: { name: input.senderName ?? "Rebook", email: process.env.BREVO_SENDER_EMAIL },
        to: [{ email: input.to, name: input.name }], subject: input.subject, textContent: input.text, htmlContent: input.html, tags: input.tags }),
      signal: AbortSignal.timeout(10_000), cache: "no-store",
    });
    if ([400, 401, 402, 429].includes(response.status)) return { kind: "rejected", reason: `Email provider rejected the request (${response.status}).` };
    if (response.status !== 201) return { kind: "unknown" };
    const data = await response.json();
    return typeof data?.messageId === "string" && data.messageId ? { kind: "accepted", messageId: data.messageId } : { kind: "unknown" };
  } catch { return { kind: "unknown" }; }
}

export function mapEmailEvents(events: { event: string; date: string }[]): EmailStatus | undefined {
  const statuses: Record<string, EmailStatus> = { requests: "sent", delivered: "delivered", opened: "delivered", clicks: "delivered",
    hardBounces: "bounced", softBounces: "bounced", blocked: "bounced", invalid: "bounced", deferred: "deferred" };
  const known = events.filter((item) => statuses[item.event]).toSorted((a, b) => Date.parse(a.date) - Date.parse(b.date));
  // Once a terminal event exists, a later request/defer event cannot undo it.
  const terminal = known.filter((item) => ["delivered", "bounced"].includes(statuses[item.event]));
  const latest = (terminal.length ? terminal : known).at(-1);
  return latest ? statuses[latest.event] : undefined;
}

export async function emailEvents(messageId: string): Promise<EmailStatus | undefined> {
  if (!emailConfigured()) return;
  try {
    const url = new URL("https://api.brevo.com/v3/smtp/statistics/events");
    url.searchParams.set("messageId", messageId); url.searchParams.set("limit", "20");
    const response = await fetch(url, { headers: { "api-key": process.env.BREVO_API_KEY! }, signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    return Array.isArray(data?.events) ? mapEmailEvents(data.events) : undefined;
  } catch { return; }
}
