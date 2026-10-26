import { afterEach, expect, it, vi } from "vitest";
import { api, ApiError } from "../lib/client/api";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(["8", "Tue, 27 Oct 2026 00:00:08 GMT"])("preserves the busy reason and Retry-After %s from the server", async (retryAfter) => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Busy preparing another studio" },
    { status: 429, headers: { "Retry-After": retryAfter } })));
  const error = await api.create().catch((cause) => cause);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 429, message: "Busy preparing another studio", retryAfter: 8 });
});
