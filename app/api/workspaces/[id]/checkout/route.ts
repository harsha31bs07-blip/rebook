import { api, WorkspaceIdSchema } from "../../../../../lib/api/http";
import { bookingCatalog } from "../../../../../lib/checkout/service";
import { checkoutLimit } from "../../../../../lib/checkout/http";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id);
    checkoutLimit(request, id);
    return bookingCatalog(id);
  });
}
