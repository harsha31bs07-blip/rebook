import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { limits } from "../lib/api/limits";
import { POST as importPost } from "../app/api/import/mindbody/route";
import { POST as pushPost } from "../app/api/workspaces/[id]/sync/mindbody/push/route";
import { POST as pullPost } from "../app/api/workspaces/[id]/sync/mindbody/pull/route";
const mocked = vi.hoisted(() => ({ create: vi.fn(), push: vi.fn(), pull: vi.fn() }));
vi.mock("../lib/connectors/mindbody/import", async (original) => ({ ...await original<typeof import("../lib/connectors/mindbody/import")>(), createMindbodyWorkspace: mocked.create }));
vi.mock("../lib/connectors/mindbody/push", () => ({ pushToMindbody: mocked.push }));
vi.mock("../lib/connectors/mindbody/pull", () => ({ pullFromMindbody: mocked.pull }));
const context = () => ({ params: Promise.resolve({ id: "abcdefghij" }) });
const request = (body: unknown = {}, origin = "http://localhost") => new Request("http://localhost/api/import/mindbody", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
beforeEach(() => { limits.reset(); vi.stubEnv("MINDBODY_API_KEY", "fixture-secret-key"); mocked.create.mockResolvedValue({ id: "abcdefghij", path: "/w/abcdefghij", summary: {}, warnings: [] }); mocked.push.mockResolvedValue({ applied: 1, failed: [], pending: 0 }); mocked.pull.mockResolvedValue({ results: [] }); });
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it.each([importPost, pushPost, pullPost])("hides disabled connector routes and rejects cross-origin requests", async (handler) => {
  vi.stubEnv("MINDBODY_API_KEY", ""); expect((await handler(request(), context())).status).toBe(404);
  vi.stubEnv("MINDBODY_API_KEY", "fixture-secret-key"); expect((await handler(request({}, "https://other.example"), context())).status).toBe(403);
  expect(mocked.create).not.toHaveBeenCalled(); expect(mocked.push).not.toHaveBeenCalled(); expect(mocked.pull).not.toHaveBeenCalled();
});
it("validates Mondays, shares the CSV creation limit, and returns only the workspace result", async () => {
  expect((await importPost(request({ weekStart: "2026-11-01" }))).status).toBe(400);
  const response = await importPost(request({ weekStart: "2026-11-02" })); expect(response.status).toBe(200);
  expect(mocked.create).toHaveBeenCalledWith({ weekStart: "2026-11-02" });
  expect(await response.text()).not.toContain("fixture-secret-key");
  for (let index = 0; index < 4; index++) expect((await importPost(request())).status).toBe(200);
  const limited = await importPost(request()); expect(limited.status).toBe(429); expect(limited.headers.get("Retry-After")).toBeTruthy();
});
it("routes push and pull to the linked workspace with a shared sync rate limit", async () => {
  expect((await pushPost(request(), context())).status).toBe(200);
  expect(mocked.push).toHaveBeenCalledWith("abcdefghij");
  for (let index = 0; index < 9; index++) expect((await pullPost(request(), context())).status).toBe(200);
  expect(mocked.pull).toHaveBeenCalledWith("abcdefghij");
  expect((await pushPost(request(), context())).status).toBe(429);
});
