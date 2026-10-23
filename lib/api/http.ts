import { z } from "zod";
import { PayPalError } from "../paypal/client";
import { StoreError } from "../store";
import { WorkspaceCreationError } from "../demo/createWorkspace";

export const WorkspaceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{10}$/);
export const PlanIdSchema = z.uuid();
export const EmptyBodySchema = z.strictObject({});
export async function jsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const raw = await request.text();
  if (raw.length > 32_768) throw new StoreError(413, "Request body is too large");
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
    if (error instanceof StoreError) return json({ error: error.message }, error.status);
    if (error instanceof PayPalError) return json({ error: "PayPal request failed", name: error.name, debugId: error.debugId }, 502);
    console.error("API request failed", error instanceof Error ? error.name : "Unknown error");
    return json({ error: "Request could not be completed" }, 500);
  }
}

const creationAttempts = new Map<string, { count: number; expiresAt: number }>();
export function rateLimitCreation(request: Request): void {
  // Deploy behind a trusted proxy that overwrites these headers. Missing IPs share a conservative bucket.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  const now = Date.now();
  for (const [key, bucket] of creationAttempts) if (bucket.expiresAt <= now) creationAttempts.delete(key);
  const bucket = creationAttempts.get(ip) ?? { count: 0, expiresAt: now + 3_600_000 };
  if (bucket.count >= 5) throw new StoreError(429, "Workspace creation limit reached; try again in an hour");
  bucket.count += 1;
  creationAttempts.set(ip, bucket);
}
