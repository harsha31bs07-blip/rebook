import { createHash } from "node:crypto";
import { z } from "zod";
import { api, jsonBody } from "../../../../lib/api/http";
import { clientIp } from "../../../../lib/api/client-ip";
import { limits } from "../../../../lib/api/limits";
import { isSameOrigin } from "../../../../lib/api/same-origin";
import { CoverTokenSchema, coverView, respondToCover } from "../../../../lib/recovery/cover-pay";
import { StoreError } from "../../../../lib/store";

export const runtime = "nodejs";
type Context = { params: Promise<{ token: string }> };
async function handle(request: Request, context: Context, write: boolean) {
  const response = await api(async () => {
    limits.take([{ key: `cover-ip:${clientIp(request)}`, max: 120, ms: 60_000 }]);
    const token = CoverTokenSchema.parse((await context.params).token);
    const digest = createHash("sha256").update(token).digest("hex");
    limits.take([{ key: `cover:${write ? "write" : "read"}:${digest}`, max: write ? 20 : 90, ms: 60_000 }]);
    if (!write) return coverView(token);
    if (!isSameOrigin(request)) throw new StoreError(403, "Please open your private cover link to respond.");
    const { action } = await jsonBody(request, z.strictObject({ action: z.enum(["accept", "decline"]) }), 256);
    return respondToCover(token, action);
  });
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}
export function GET(request: Request, context: Context) { return handle(request, context, false); }
export function POST(request: Request, context: Context) { return handle(request, context, true); }
