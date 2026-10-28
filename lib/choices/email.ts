import { limits } from "../api/limits";
import { emailConfigured, emailEvents, sendEmail } from "../notify/email";
import { getRepository, StoreError, type Repository } from "../store";
import { outboxEmail } from "./email-content";
import { outboxState } from "./outbox";
import { ownerCustomerChoices } from "./service";

export function requireEmail(): void {
  if (!emailConfigured()) throw new StoreError(503, "Email delivery is not configured. Set BREVO_API_KEY and BREVO_SENDER_EMAIL on the server, or use a sharing app.");
}
export async function sendCustomerEmail(workspaceId: string, input: { planId: string; customerId: string; reminder?: boolean; resend?: boolean }, origin: string, client: string, repository = getRepository()) {
  requireEmail();
  const { state } = repository.requireReadyWorkspace(workspaceId);
  const row = ownerCustomerChoices(workspaceId, repository).outbox.find((item) => item.planId === input.planId && item.customerId === input.customerId);
  if (!row) throw new StoreError(404, "Customer message not found in this recovery.");
  if (!row.emailDeliverable) throw new StoreError(422, "Demo address · not sent");
  if (input.reminder && !outboxState(row).waiting) throw new StoreError(409, "This customer is not waiting for a reply.");
  const customer = state.customers.find((item) => item.id === row.customerId)!;
  const content = outboxEmail(row, state.studio.name, origin, input.reminder);
  const delivery = repository.queueDelivery({ workspaceId, planId: input.planId, customerId: input.customerId, kind: input.reminder ? "reminder" : "message" }, input.resend, () => limits.email(client, workspaceId));
  const result = await sendEmail({ ...content, to: customer.email, name: customer.name, tags: ["rebook"] });
  repository.transaction(() => {
    const current = repository.listDeliveries(workspaceId).find((item) => item.planId === delivery.planId && item.customerId === delivery.customerId && item.kind === delivery.kind);
    if (current?.attemptId !== delivery.attemptId) return;
    const now = new Date().toISOString();
    repository.saveDelivery({ ...delivery, status: result.kind === "accepted" ? "sent" : result.kind === "rejected" ? "failed" : "unknown",
      messageId: result.kind === "accepted" ? result.messageId : undefined, reason: result.kind === "rejected" ? result.reason : undefined, updatedAt: now });
    if (result.kind === "accepted") {
      for (const link of repository.listCustomerLinks(workspaceId).filter((link) => link.planId === input.planId && row.changes.some((change) => change.bookingId === link.bookingId))) {
        repository.saveCustomerLink({ ...link, sentAt: now });
      }
    }
  });
  return ownerCustomerChoices(workspaceId, repository);
}

export async function sendAllCustomerEmails(workspaceId: string, planId: string, origin: string, client: string, repository = getRepository()) {
  requireEmail(); repository.requireReadyWorkspace(workspaceId);
  const rows = ownerCustomerChoices(workspaceId, repository).outbox.filter((row) => row.planId === planId);
  if (!rows.length) throw new StoreError(404, "Customer messages not found in this recovery.");
  for (const row of rows.filter((item) => item.emailDeliverable && !outboxState(item).sent && (!item.delivery || item.delivery.status === "failed"))) {
    try { await sendCustomerEmail(workspaceId, { planId, customerId: row.customerId }, origin, client, repository); }
    catch (error) { if (!(error instanceof StoreError && error.status === 409)) throw error; }
  }
  return ownerCustomerChoices(workspaceId, repository);
}

export async function refreshEmailStatus(workspaceId: string, repository: Repository = getRepository()) {
  repository.requireReadyWorkspace(workspaceId);
  const deliveries = repository.listDeliveries(workspaceId).filter((row) => ["sent", "deferred"].includes(row.status) && row.messageId && Date.parse(row.createdAt) + 3 * 86_400_000 > Date.now());
  if (emailConfigured() && deliveries.length && repository.claimEmailCheck(workspaceId)) {
    await Promise.all(deliveries.map(async (delivery) => {
      const status = await emailEvents(delivery.messageId!);
      if (!status) return;
      repository.transaction(() => {
        const current = repository.listDeliveries(workspaceId).find((row) => row.planId === delivery.planId && row.customerId === delivery.customerId && row.kind === delivery.kind);
        if (current?.attemptId === delivery.attemptId && ["sent", "deferred"].includes(current.status)) repository.saveDelivery({ ...current, status, updatedAt: new Date().toISOString() });
      });
    }));
  }
  return ownerCustomerChoices(workspaceId, repository);
}
