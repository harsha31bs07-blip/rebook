import { afterEach, expect, it, vi } from "vitest";

const recovery = vi.hoisted(() => ({ resume: vi.fn(), prune: vi.fn(), pool: vi.fn() }));
vi.mock("../lib/store", () => ({ startPruning: recovery.prune }));
vi.mock("../lib/demo/createWorkspace", () => ({ resumeStalePreparations: recovery.resume, startWarmPool: recovery.pool }));
import { register } from "../instrumentation";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it("runs startup recovery before the first prune or pool fill", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  let resolve!: () => void;
  recovery.resume.mockReturnValue(new Promise<void>((done) => { resolve = done; }));
  recovery.pool.mockResolvedValue(undefined);
  const startup = register();
  await vi.waitFor(() => expect(recovery.resume).toHaveBeenCalled());
  expect(recovery.prune).not.toHaveBeenCalled();
  expect(recovery.pool).not.toHaveBeenCalled();
  resolve();
  await startup;
  expect(recovery.prune).toHaveBeenCalledOnce();
  expect(recovery.pool).toHaveBeenCalledOnce();
});
