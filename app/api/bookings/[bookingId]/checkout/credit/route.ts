import { randomUUID } from "node:crypto";
import { z } from "zod";
import { api, jsonBody } from "../../../../../../lib/api/http";
import { publicCheckoutWorkspace } from "../../../../../../lib/checkout/http";
import { CreditCheckoutInputSchema, CreditTokenSchema, redeemCredit, studioCredit } from "../../../../../../lib/checkout/service";

export const runtime = "nodejs";
const InputSchema = z.union([CreditCheckoutInputSchema, z.strictObject({ creditToken: CreditTokenSchema })]);
export async function POST(request: Request, context: { params: Promise<{ bookingId: string }> }) {
  return api(async () => {
    const id = publicCheckoutWorkspace(request, (await context.params).bookingId);
    const input = await jsonBody(request, InputSchema, 2048);
    if (!("sessionId" in input)) return studioCredit(id, input.creditToken);
    const key = z.uuid().parse(request.headers.get("idempotency-key") ?? randomUUID());
    return redeemCredit(id, input, key);
  });
}
