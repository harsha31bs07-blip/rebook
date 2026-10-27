import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";

afterEach(() => vi.unstubAllEnvs());
it.each(["/w/demo", "/w/demo/book", "/b/public-booking-id", "/c/private-token", "/api/paypal/webhook"])("uses a fresh matching request/response script nonce without unsafe-inline on %s", (path) => {
  vi.stubEnv("NODE_ENV", "production");
  const request = new NextRequest(`http://localhost${path}`, { headers: { "x-nonce": "spoof", "content-security-policy": "script-src 'unsafe-inline'" } });
  const response = proxy(request);
  const csp = response.headers.get("content-security-policy")!;
  const script = csp.split(";").find((value) => value.trim().startsWith("script-src"))!;
  expect(script).not.toContain("unsafe-inline");
  expect(script).not.toContain("unsafe-eval");
  expect(script).toContain("https://*.paypal.com");
  expect(script).toContain("https://*.paypalobjects.com");
  const nonce = response.headers.get("x-middleware-request-x-nonce")!;
  expect(nonce).not.toBe("spoof");
  expect(script).toContain(`'nonce-${nonce}'`);
  expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
  expect(proxy(request).headers.get("content-security-policy")).not.toBe(csp);
  expect(csp).toContain("style-src 'self' 'unsafe-inline'");
});

it("permits development debugging without enabling inline scripts", () => {
  vi.stubEnv("NODE_ENV", "development");
  const csp = proxy(new NextRequest("http://localhost/")).headers.get("content-security-policy")!;
  const script = csp.split(";").find((value) => value.trim().startsWith("script-src"))!;
  expect(script).toContain("'unsafe-eval'");
  expect(script).not.toContain("'unsafe-inline'");
});
