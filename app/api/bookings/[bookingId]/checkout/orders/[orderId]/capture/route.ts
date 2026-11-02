import { api, EmptyBodySchema, jsonBody } from "../../../../../../../../lib/api/http";
import { OrderIdSchema, publicCheckoutWorkspace } from "../../../../../../../../lib/checkout/http";
import { captureCheckout } from "../../../../../../../../lib/checkout/service";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ bookingId: string; orderId: string }> }) {
  return api(async () => {
    const params = await context.params;
    const id = publicCheckoutWorkspace(request, params.bookingId);
    await jsonBody(request, EmptyBodySchema, 1024);
    return captureCheckout(id, OrderIdSchema.parse(params.orderId));
  });
}
