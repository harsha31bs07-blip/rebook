import { z } from "zod";
import { MoneySchema } from "../domain/schemas";
import type { LedgerEvent } from "../store";
import type { PayPalPayment } from "./client";

const Evidence = z.object({
  id: z.string().min(1), status: z.string().min(1), invoice_id: z.string().optional(), request_id: z.string().optional(),
  paypal_request_id: z.string().optional(),
  amount: z.object({ currency_code: z.literal("USD"), value: MoneySchema }),
});

/** A capture or amount alone cannot identify a particular refund operation. */
export function matchingRefund(candidate: unknown, event: LedgerEvent): PayPalPayment | undefined {
  const parsed = Evidence.safeParse(candidate);
  if (!parsed.success) return;
  const refund = parsed.data;
  if (refund.invoice_id !== undefined && refund.invoice_id !== event.requestId) return;
  if (event.paypalId && refund.id !== event.paypalId) return;
  if ([refund.request_id, refund.paypal_request_id].some((id) => id !== undefined && id !== event.requestId)) return;
  if (refund.invoice_id !== event.requestId && refund.id !== event.paypalId) return;
  if (refund.amount.value !== event.amount) return;
  return { id: refund.id, status: refund.status, amount: refund.amount };
}
