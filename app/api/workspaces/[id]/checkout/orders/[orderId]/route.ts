import { api, WorkspaceIdSchema } from "../../../../../../../lib/api/http";
import { checkoutLimit, OrderIdSchema } from "../../../../../../../lib/checkout/http";
import { cancelCheckout, receipt } from "../../../../../../../lib/checkout/service";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; orderId: string }> };
export async function GET(request: Request, context: Context) {
  return api(async () => {
    const params = await context.params;
    const id = WorkspaceIdSchema.parse(params.id);
    checkoutLimit(request, id);
    return receipt(id, OrderIdSchema.parse(params.orderId));
  });
}
export async function DELETE(request: Request, context: Context) {
  return api(async () => {
    const params = await context.params;
    const id = WorkspaceIdSchema.parse(params.id);
    checkoutLimit(request, id);
    return cancelCheckout(id, OrderIdSchema.parse(params.orderId));
  });
}
