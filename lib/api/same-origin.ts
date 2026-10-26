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
