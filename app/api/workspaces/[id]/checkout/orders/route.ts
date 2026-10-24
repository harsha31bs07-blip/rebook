import { randomUUID } from "node:crypto";
import { z } from "zod";
import { api, jsonBody, WorkspaceIdSchema } from "../../../../../../lib/api/http";
import { checkoutLimit } from "../../../../../../lib/checkout/http";
import { CheckoutInputSchema, createOrder } from "../../../../../../lib/checkout/service";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id);
    checkoutLimit(request, id);
    const input = await jsonBody(request, CheckoutInputSchema, 2048);
    const key = z.uuid().parse(request.headers.get("idempotency-key") ?? randomUUID());
    return createOrder(id, input, key);
  });
}
