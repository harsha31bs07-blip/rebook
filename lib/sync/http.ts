import { timingSafeEqual } from "node:crypto";
import { clientIp } from "../api/client-ip";
import { limits } from "../api/limits";
import { StoreError, type Repository } from "../store";

export function authenticateSync(request: Request, workspaceId: string, repository: Repository): void {
  repository.requireWorkspace(workspaceId);
  limits.take([{ key: `sync:${workspaceId}:${clientIp(request)}`, max: 60, ms: 60_000 }]);
  const actual = Buffer.from(request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? "");
  const expected = Buffer.from(repository.syncKey(workspaceId));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new StoreError(401, "Invalid sync key");
}
