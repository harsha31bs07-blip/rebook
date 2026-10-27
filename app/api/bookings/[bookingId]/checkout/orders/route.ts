import { randomUUID } from "node:crypto";
import { z } from "zod";
import { api, jsonBody } from "../../../../../../lib/api/http";
import { publicCheckoutWorkspace } from "../../../../../../lib/checkout/http";
import { CheckoutInputSchema, createOrder } from "../../../../../../lib/checkout/service";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ bookingId: string }> }) {
  return api(async () => {
    const id = publicCheckoutWorkspace(request, (await context.params).bookingId);
    const input = await jsonBody(request, CheckoutInputSchema, 2048);
    const key = z.uuid().parse(request.headers.get("idempotency-key") ?? randomUUID());
    return createOrder(id, input, key);
  });
}
