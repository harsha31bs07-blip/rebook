import { api, WorkspaceIdSchema } from "../../../../../lib/api/http";
import { isSameOrigin } from "../../../../../lib/api/same-origin";
import { limits } from "../../../../../lib/api/limits";
import { getRepository, StoreError } from "../../../../../lib/store";
import { verifyWorkspaceMoney, type MoneyVerification } from "../../../../../lib/paypal/verify";

export const runtime = "nodejs";
const cache = new Map<string, { until: number; result: Promise<MoneyVerification> }>();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    if (!isSameOrigin(request)) throw new StoreError(403, "Please open the owner console to verify with PayPal.");
    const id = WorkspaceIdSchema.parse((await context.params).id);
    const repository = getRepository();
    repository.requireReadyWorkspace(id);
    limits.take([{ key: `verify:${id}`, max: 3, ms: 60_000 }]);
    const now = Date.now();
    for (const [key, entry] of cache) if (entry.until <= now) cache.delete(key);
    const previous = cache.get(id);
    if (previous) return previous.result;
    const entry = { until: Number.POSITIVE_INFINITY, result: verifyWorkspaceMoney(id, repository) };
    cache.set(id, entry);
    try {
      const result = await entry.result;
      entry.until = Date.now() + 30_000;
      return result;
    } catch (error) { cache.delete(id); throw error; }
  });
}
