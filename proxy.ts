import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const paypal = "https://*.paypal.com", objects = "https://*.paypalobjects.com";
  // Next 16 reads this request header and nonces its inline bootstrap. Keep host
  // sources for PayPal's dynamically loaded SDK; scheduler/chart inline styles remain allowed.
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""} ${paypal} ${objects}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${paypal}`, `frame-src ${paypal}`,
    `img-src 'self' data: blob: ${paypal} ${objects}`,
    "font-src 'self' data:", "worker-src 'self' blob:",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
