import { randomUUID } from "node:crypto";
import { getRepository, StoreError, type Repository } from "../../store";
import { mindbodyEnabled } from "./client";
import type { MindbodyStatus } from "./types";

export function ownerMindbody(workspaceId: string, repository: Repository = getRepository()): MindbodyStatus | undefined {
  const link = repository.mindbodyLink(workspaceId);
  return link ? { connected: mindbodyEnabled(), location: link.location, week: link.week, lastPush: link.lastPush, lastPull: link.lastPull } : undefined;
}
export async function withMindbodyLock<T>(workspaceId: string, repository: Repository, operation: (fence: () => void) => Promise<T>): Promise<T> {
  repository.requireReadyWorkspace(workspaceId);
  if (!repository.mindbodyLink(workspaceId)) throw new StoreError(404, "This workspace is not connected to Mindbody.");
  const owner = randomUUID(); repository.acquireMindbodyLock(workspaceId, owner);
  const fence = () => repository.renewMindbodyLock(workspaceId, owner);
  const heartbeat = setInterval(() => { try { fence(); } catch {} }, 30_000); heartbeat.unref();
  try { return await operation(fence); }
  finally { clearInterval(heartbeat); repository.releaseMindbodyLock(workspaceId, owner); }
}
