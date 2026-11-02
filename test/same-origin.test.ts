import { afterEach, describe, expect, it, vi } from "vitest";
import { isSameOrigin, publicOrigin } from "../lib/api/same-origin";

const internal = "http://localhost:10000/api/workspaces/x/checkout/orders";
const post = (headers: Record<string, string>) => new Request(internal, { method: "POST", headers });

describe("isSameOrigin behind a proxy", () => {
  afterEach(() => { delete process.env.PUBLIC_ORIGIN; });
  it("accepts requests without an Origin header", () => expect(isSameOrigin(post({}))).toBe(true));
  it("accepts the public origin from forwarded headers", () => {
    expect(isSameOrigin(post({ origin: "https://rebook-by9u.onrender.com", "x-forwarded-host": "rebook-by9u.onrender.com", "x-forwarded-proto": "https" }))).toBe(true);
  });
  it("accepts the configured PUBLIC_ORIGIN", () => {
    process.env.PUBLIC_ORIGIN = "https://rebook-by9u.onrender.com";
    expect(isSameOrigin(post({ origin: "https://rebook-by9u.onrender.com" }))).toBe(true);
  });
  it("rejects other sites", () => {
    process.env.PUBLIC_ORIGIN = "https://rebook-by9u.onrender.com";
    expect(isSameOrigin(post({ origin: "https://evil.example", "x-forwarded-host": "rebook-by9u.onrender.com" }))).toBe(false);
  });
});

describe("publicOrigin for links that reach customers and PayPal", () => {
  afterEach(() => { delete process.env.PUBLIC_ORIGIN; vi.unstubAllEnvs(); });
  it("refuses a Host header in production without PUBLIC_ORIGIN", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => publicOrigin(post({ "x-forwarded-host": "evil.example" }))).toThrow("PUBLIC_ORIGIN");
    expect(publicOrigin(post({ host: "localhost:3100", "x-forwarded-proto": "http" }))).toBe("http://localhost:3100");
    process.env.PUBLIC_ORIGIN = "https://rebook-by9u.onrender.com";
    expect(publicOrigin(post({ "x-forwarded-host": "evil.example" }))).toBe("https://rebook-by9u.onrender.com");
  });
});
