import { StoreError } from "../store";

/**
 * Behind a proxy (Render), request.url carries the internal address, so a browser's Origin header never matches
 * it. Accept the public origin too: PUBLIC_ORIGIN when configured, otherwise the forwarded host and protocol.
 */
export function allowedOrigins(request: Request): Set<string> {
  const origins = new Set([new URL(request.url).origin]);
  const configured = process.env.PUBLIC_ORIGIN?.trim();
  if (configured) origins.add(new URL(configured).origin);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host) {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() || "https";
    origins.add(`${proto}://${host.split(",")[0].trim()}`);
  }
  return origins;
}

/** True when the request has no Origin header (non-browser client) or comes from this site. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || allowedOrigins(request).has(origin);
}

/** The address for links that reach customers and PayPal. Outside local development a Host header can't be trusted to name this site. */
export function publicOrigin(request: Request): string {
  const configured = process.env.PUBLIC_ORIGIN?.trim();
  if (configured) return new URL(configured).origin;
  const fallback = [...allowedOrigins(request)].at(-1)!;
  if (process.env.NODE_ENV === "production" && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(fallback)) throw new StoreError(503, "This server needs PUBLIC_ORIGIN, its public address, to create links.");
  return fallback;
}
