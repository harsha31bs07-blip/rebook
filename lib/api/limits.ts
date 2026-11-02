import { StoreError } from "../store";

export function envLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return process.env[name]?.trim() && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** Fixed windows, checked together before any counter is spent. */
export class Limits {
  private buckets = new Map<string, { count: number; until: number }>();
  private preparations = 0;
  private ai = 0;
  /** Tests can model a new server process without changing production limits. */
  reset(): void { this.buckets.clear(); this.preparations = 0; this.ai = 0; }
  take(entries: { key: string; max: number; ms: number; count?: number }[], status = 429): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) if (bucket.until <= now) this.buckets.delete(key);
    for (const entry of entries) {
      const bucket = this.buckets.get(entry.key);
      if ((bucket?.count ?? 0) + (entry.count ?? 1) > entry.max) {
        throw new StoreError(status, status === 503
          ? "The analyst is busy. Please try again shortly; your studio records are still available."
          : "The demo is busy. Please try again shortly.", undefined, Math.max(1, Math.ceil(((bucket?.until ?? now + entry.ms) - now) / 1000)));
      }
    }
    for (const entry of entries) {
      const bucket = this.buckets.get(entry.key) ?? { count: 0, until: now + entry.ms };
      bucket.count += entry.count ?? 1;
      this.buckets.set(entry.key, bucket);
    }
  }
  preparation(captures: number, creation = true): () => void {
    if (this.preparations >= envLimit("MAX_CONCURRENT_PREPARATIONS", 2)) throw new StoreError(429, "Studios are being prepared. Please try again shortly.", undefined, 60);
    this.take([
      ...(creation ? [{ key: "creations", max: envLimit("MAX_WORKSPACE_CREATIONS_PER_HOUR", 60), ms: 3_600_000 }] : []),
      { key: "captures", max: envLimit("MAX_REAL_CAPTURES_PER_HOUR", 1500), ms: 3_600_000, count: captures },
    ]);
    this.preparations++;
    let released = false;
    return () => { if (!released) { released = true; this.preparations--; } };
  }
  aiCall(client: string, workspace: string): () => void {
    if (this.ai >= envLimit("AI_MAX_CONCURRENT", 4)) throw new StoreError(503, "The analyst is busy. Please try again shortly.", undefined, 30);
    this.take([
      { key: "ai-minute", max: envLimit("AI_CALLS_PER_MIN", 30), ms: 60_000 },
      { key: "ai-day", max: envLimit("AI_CALLS_PER_DAY", 1200), ms: 86_400_000 },
      { key: `ai-client:${client}`, max: envLimit("AI_CLIENT_CALLS_PER_MIN", 10), ms: 60_000 },
      { key: `ai-workspace:${workspace}`, max: envLimit("AI_WORKSPACE_CALLS_PER_MIN", 10), ms: 60_000 },
    ], 503);
    this.ai++;
    let released = false;
    return () => { if (!released) { released = true; this.ai--; } };
  }
}

const shared = globalThis as typeof globalThis & { rebookLimits?: Limits };
export const limits = shared.rebookLimits ??= new Limits();
