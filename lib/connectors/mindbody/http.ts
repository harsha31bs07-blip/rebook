import { api, EmptyBodySchema, jsonBody, WorkspaceIdSchema } from "../../api/http";
import { clientIp } from "../../api/client-ip";
import { limits } from "../../api/limits";
import { isSameOrigin } from "../../api/same-origin";
import { StoreError } from "../../store";
import { mindbodyEnabled } from "./client";
import { pushToMindbody } from "./push";
import { pullFromMindbody } from "./pull";

export function requireMindbodyRequest(request: Request): void {
  if (!mindbodyEnabled()) throw new StoreError(404, "Mindbody connector is disabled.");
  if (!isSameOrigin(request)) throw new StoreError(403, "Please use this studio's page.");
}
export function mindbodySyncRequest(request: Request, context: { params: Promise<{ id: string }> }, action: "push" | "pull") {
  return api(async () => {
    requireMindbodyRequest(request);
    const id = WorkspaceIdSchema.parse((await context.params).id);
    limits.take([{ key: `mindbody-sync:${id}:${clientIp(request)}`, max: 10, ms: 60_000 }]);
    await jsonBody(request, EmptyBodySchema);
    return action === "push" ? pushToMindbody(id) : pullFromMindbody(id);
  });
}
