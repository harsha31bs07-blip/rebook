import { createHash } from "node:crypto";
import { z } from "zod";
import { api, jsonBody } from "../../../../../lib/api/http";
import { clientIp } from "../../../../../lib/api/client-ip";
import { limits } from "../../../../../lib/api/limits";
import { isSameOrigin } from "../../../../../lib/api/same-origin";
import { ChoiceTokenSchema } from "../../../../../lib/choices/service";
import { proposeChoice } from "../../../../../lib/choices/assistant";
import { StoreError } from "../../../../../lib/store";

export const runtime = "nodejs";
const InputSchema = z.strictObject({ message: z.string().trim().min(1).max(300) });
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const response = await api(async () => {
    const token = ChoiceTokenSchema.parse((await context.params).token);
    if (!isSameOrigin(request)) throw new StoreError(403, "Please open your private link to make a choice.");
    const { message } = await jsonBody(request, InputSchema, 2048);
    const digest = createHash("sha256").update(token).digest("hex");
    limits.take([{ key: `choice-assistant:${digest}`, max: 6, ms: 600_000 }, { key: `choice-assistant-ip:${clientIp(request)}`, max: 30, ms: 600_000 }]);
    return proposeChoice(token, message);
  });
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}
