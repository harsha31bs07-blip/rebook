import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceResponse } from "../lib/client/api";

const harness = vi.hoisted(() => ({ read: vi.fn(), effects: [] as (() => (() => void) | void)[] }));
vi.mock("@/lib/client/api", () => ({ api: { workspace: harness.read }, ApiError: class extends Error {} }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [value, vi.fn()],
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void) | void) => { harness.effects.push(effect); },
}));
import { useWorkspace } from "../components/console/use-workspace";

afterEach(() => { vi.useRealTimers(); harness.effects = []; harness.read.mockReset(); });
it.each(["PENDING", "REQUESTED", "UNKNOWN", "NEEDS_REVIEW"])("backs off %s refunds and keeps polling past two minutes until unmount", async (status) => {
  vi.useFakeTimers();
  const workspace = { id: "demo", status: "ready", state: { bookings: [], sessions: [], customers: [], studio: { timezone: "UTC" } }, plans: [], ledger: [{ kind: "refund", requestId: "key", status }] } as unknown as WorkspaceResponse;
  harness.read.mockResolvedValue(workspace);
  useWorkspace("demo", false);
  const cleanups = harness.effects.map((effect) => effect());
  await vi.advanceTimersByTimeAsync(0);
  expect(harness.read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(harness.read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(27_000);
  const at30 = harness.read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(9999);
  expect(harness.read).toHaveBeenCalledTimes(at30);
  await vi.advanceTimersByTimeAsync(1);
  expect(harness.read).toHaveBeenCalledTimes(at30 + 1);
  await vi.advanceTimersByTimeAsync(80_000);
  const at120 = harness.read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(29_999);
  expect(harness.read).toHaveBeenCalledTimes(at120);
  await vi.advanceTimersByTimeAsync(1);
  expect(harness.read).toHaveBeenCalledTimes(at120 + 1);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(harness.read).toHaveBeenCalledTimes(at120 + 21);
  harness.read.mockRejectedValueOnce(new Error("temporary outage"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(harness.read).toHaveBeenCalledTimes(at120 + 23);
  for (const cleanup of cleanups) cleanup?.();
  const atUnmount = harness.read.mock.calls.length;
  expect((harness.read.mock.calls.at(-1)![1] as AbortSignal).aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(harness.read).toHaveBeenCalledTimes(atUnmount);
});
