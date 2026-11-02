import { PayPalError, request } from "./client";

// Server SDK 2.5.0 has no Payouts controller, so these use the same OAuth/PayPal-Request-Id REST helper as webhooks.
type BatchResponse = {
  batch_header?: { payout_batch_id?: string; batch_status?: string; sender_batch_header?: { sender_batch_id?: string } };
  items?: { payout_item_id?: string; transaction_status?: string; payout_item?: { sender_item_id?: string; receiver?: string; amount?: { value: string; currency: string } }; errors?: { name?: string; message?: string } }[];
};
export type PayoutState = { batchId?: string; batchStatus?: string; senderBatchId?: string; senderItemId?: string; receiver?: string; itemId?: string; itemStatus?: string; amount?: { value: string; currency: string }; error?: string };

/** A duplicate identifies an existing batch, even when its link is missing or unsafe to use. */
export function duplicatePayoutBatch(error: unknown): { batchId?: string } | undefined {
  if (!(error instanceof PayPalError)) return;
  const details = error.details?.filter((detail) => detail.field === "SENDER_BATCH_ID" && detail.issue === "Batch with given sender_batch_id already exists");
  if (!details?.length) return;
  for (const detail of details) for (const link of detail.link ?? []) {
    if (link.rel !== "self" || link.method !== "GET") continue;
    const match = /^https:\/\/(?:api|api-m)\.sandbox\.paypal\.com\/v1\/payments\/payouts\/([A-Za-z0-9_-]{1,64})$/.exec(link.href);
    if (match?.[0] === link.href) return { batchId: match[1] };
  }
  return {};
}

/** One email payout. A repeated sender_batch_id is rejected with a link to the original batch. */
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
    senderBatchId: body.batch_header?.sender_batch_header?.sender_batch_id, senderItemId: item?.payout_item?.sender_item_id, receiver: item?.payout_item?.receiver,
    amount: item?.payout_item?.amount, error: item?.errors?.message ?? item?.errors?.name };
}
