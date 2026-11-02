import { api } from "../../../../../lib/api/http";
import { publicCheckoutWorkspace } from "../../../../../lib/checkout/http";
import { bookingCatalog } from "../../../../../lib/checkout/service";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ bookingId: string }> }) {
  return api(async () => bookingCatalog(publicCheckoutWorkspace(request, (await context.params).bookingId)));
}
