import { z } from "zod";
import { PayPalError } from "../paypal/client";
import { StoreError } from "../store";
import { WorkspaceCreationError } from "../demo/createWorkspace";
import { clientIp } from "./client-ip";
import { limits } from "./limits";

export const WorkspaceIdSchema = z.string().transform((id) => {
  if (!/^[A-Za-z0-9_-]{10}$/.test(id)) throw new StoreError(404, "This demo has ended (demos reset when the server restarts). Start a fresh one.", "expired");
  return id;
});
export const PlanIdSchema = z.uuid();
export const EmptyBodySchema = z.strictObject({});
export async function readBody(request: Request, maxBytes = 32_768): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new StoreError(413, "Request body is too large. Please shorten it and try again.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString("utf8");
}
export async function jsonBody<T>(request: Request, schema: z.ZodType<T>, maxBytes = 32_768): Promise<T> {
  const raw = await readBody(request, maxBytes);
  let body: unknown;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { throw new StoreError(400, "Invalid JSON"); }
  return schema.parse(body);
}
export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
export async function api(operation: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    const result = await operation();
    return result instanceof Response ? result : json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return json({ error: "Invalid input", issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) }, 400);
    if (error instanceof WorkspaceCreationError) return json({ error: error.message, workspaceId: error.workspaceId }, error.status);
    if (error instanceof StoreError) {
      const response = json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
      if (error.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
      return response;
    }
    if (error instanceof PayPalError) return json({ error: "PayPal request failed", name: error.name, debugId: error.debugId }, 502);
    console.error("API request failed", error instanceof Error ? error.name : "Unknown error");
    return json({ error: "Request could not be completed" }, 500);
  }
}

export function rateLimitCreation(request: Request): void {
  limits.take([{ key: `creation:${clientIp(request)}`, max: 5, ms: 3_600_000 }]);
}
