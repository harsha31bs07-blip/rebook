import { api, EmptyBodySchema, jsonBody, WorkspaceIdSchema } from "../../../../../../../../lib/api/http";
import { checkoutLimit, OrderIdSchema } from "../../../../../../../../lib/checkout/http";
import { captureCheckout } from "../../../../../../../../lib/checkout/service";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string; orderId: string }> }) {
  return api(async () => {
    const params = await context.params;
    const id = WorkspaceIdSchema.parse(params.id);
    checkoutLimit(request, id);
    await jsonBody(request, EmptyBodySchema, 1024);
    return captureCheckout(id, OrderIdSchema.parse(params.orderId));
  });
}
