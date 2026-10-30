import { createHash } from "node:crypto";
import { api, jsonBody } from "../../../../lib/api/http";
import { clientIp } from "../../../../lib/api/client-ip";
import { limits } from "../../../../lib/api/limits";
import { isSameOrigin } from "../../../../lib/api/same-origin";
import { StoreError } from "../../../../lib/store";
import { OfferActionSchema, WaitlistTokenSchema, respondToWaitlistOffer, waitlistOfferView } from "../../../../lib/waitlist/service";

type Context = { params: Promise<{ token: string }> };
async function handle(request: Request, context: Context, write: boolean) {
  const response = await api(async () => {
    limits.take([{ key: `waitlist-ip:${clientIp(request)}`, max: 120, ms: 60_000 }]);
    const token = WaitlistTokenSchema.parse((await context.params).token);
    const digest = createHash("sha256").update(token).digest("hex");
    limits.take([{ key: `waitlist:${write ? "write" : "read"}:${digest}`, max: write ? 20 : 90, ms: 60_000 }]);
    if (!write) return waitlistOfferView(token);
    if (!isSameOrigin(request)) throw new StoreError(403, "Please open your private link to claim or decline a spot.");
    const input = await jsonBody(request, OfferActionSchema, 1024);
    return respondToWaitlistOffer(token, input.action);
  });
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}
export function GET(request: Request, context: Context) { return handle(request, context, false); }
export function POST(request: Request, context: Context) { return handle(request, context, true); }
