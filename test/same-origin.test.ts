import { afterEach, describe, expect, it } from "vitest";
import { isSameOrigin } from "../lib/api/same-origin";

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
