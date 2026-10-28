import { request } from "./client";

// Server SDK 2.5.0 has no Payouts controller, so these use the same OAuth/PayPal-Request-Id REST helper as webhooks.
type BatchResponse = {
  batch_header?: { payout_batch_id?: string; batch_status?: string };
  items?: { payout_item_id?: string; transaction_status?: string; errors?: { name?: string; message?: string } }[];
};
export type PayoutState = { batchId?: string; batchStatus?: string; itemId?: string; itemStatus?: string; error?: string };

/** One email payout. The request id doubles as sender_batch_id, so a replay returns the original batch. */
export async function createPayout(input: { requestId: string; receiver: string; amount: string; subject: string; note: string }): Promise<PayoutState> {
  const body = await request<BatchResponse>("/v1/payments/payouts", { requestId: input.requestId, body: {
    sender_batch_header: { sender_batch_id: input.requestId, email_subject: input.subject, email_message: input.note },
    items: [{ recipient_type: "EMAIL", receiver: input.receiver, amount: { value: input.amount, currency: "USD" }, note: input.note, sender_item_id: input.requestId }],
  } });
  // A success without a batch id (e.g. a truncated body) proves nothing; the caller keeps the payout unresolved.
  if (!body.batch_header?.payout_batch_id) throw new Error("PayPal accepted the payout without a batch id");
  return { batchId: body.batch_header.payout_batch_id, batchStatus: body.batch_header.batch_status };
}

export async function getPayout(batchId: string): Promise<PayoutState> {
  const body = await request<BatchResponse>(`/v1/payments/payouts/${encodeURIComponent(batchId)}`, { method: "GET" });
  const item = body.items?.[0];
  return { batchId, batchStatus: body.batch_header?.batch_status, itemId: item?.payout_item_id, itemStatus: item?.transaction_status,
    error: item?.errors?.message ?? item?.errors?.name };
}
