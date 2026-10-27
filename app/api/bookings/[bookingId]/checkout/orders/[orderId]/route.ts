import { api } from "../../../../../../../lib/api/http";
import { OrderIdSchema, publicCheckoutWorkspace } from "../../../../../../../lib/checkout/http";
import { cancelCheckout, receipt } from "../../../../../../../lib/checkout/service";

export const runtime = "nodejs";
type Context = { params: Promise<{ bookingId: string; orderId: string }> };
export async function GET(request: Request, context: Context) {
  return api(async () => {
    const params = await context.params;
    const id = publicCheckoutWorkspace(request, params.bookingId);
    return receipt(id, OrderIdSchema.parse(params.orderId));
  });
}
export async function DELETE(request: Request, context: Context) {
  return api(async () => {
    const params = await context.params;
    const id = publicCheckoutWorkspace(request, params.bookingId);
    return cancelCheckout(id, OrderIdSchema.parse(params.orderId));
  });
}
