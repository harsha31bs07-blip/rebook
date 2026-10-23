import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Plan, State } from "../domain/types";
import { PlanSchema, StateSchema } from "../domain/schemas";
import { fromCents, toCents } from "../domain/time";

export type ExecutionResult = { bookingId: string; status: string; paypalId?: string; error?: string; debugId?: string };
export type StoredPlan = Plan & {
  id: string; workspaceId: string; status: "proposed" | "executing" | "executed" | "partially_failed";
  createdAt: string; results: ExecutionResult[]; basis?: State;
};
export type Workspace = { id: string; state: State; createdAt: string; updatedAt: string };
export type LedgerEvent = {
  id: string; workspaceId: string; bookingId: string; kind: "capture" | "refund";
  amount: string; paypalId: string; status: string; createdAt: string; debugId?: string;
  requestId: string; captureId: string;
};
type LedgerInput = Omit<LedgerEvent, "id" | "createdAt">;
type JsonRow = { data: string };
export class StoreError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class Repository {
  private db: DatabaseSync;
  constructor(directory = process.env.DATA_DIR || "./.data") {
    mkdirSync(resolve(/* turbopackIgnore: true */ directory), { recursive: true });
    this.db = new DatabaseSync(join(resolve(/* turbopackIgnore: true */ directory), "rebook.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        paypal_id TEXT NOT NULL, capture_id TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_workspace ON ledger(workspace_id);
      CREATE INDEX IF NOT EXISTS ledger_paypal ON ledger(paypal_id);
      CREATE INDEX IF NOT EXISTS ledger_capture ON ledger(capture_id);
      CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, raw_body TEXT NOT NULL, received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_locks (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
  }
  close(): void { this.db.close(); }
  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  createWorkspace(state: State, id = randomBytes(8).toString("base64url").slice(0, 10)): Workspace {
    const now = new Date().toISOString();
    const workspace = { id, state: StateSchema.parse(state), createdAt: now, updatedAt: now };
    this.db.prepare("INSERT INTO workspaces VALUES (?, ?, ?)").run(id, JSON.stringify(workspace), now);
    return workspace;
  }
  getWorkspace(id: string): Workspace | undefined {
    const row = this.db.prepare("SELECT data FROM workspaces WHERE id = ?").get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.data) as Workspace : undefined;
  }
  requireWorkspace(id: string): Workspace {
    const workspace = this.getWorkspace(id);
    if (!workspace) throw new StoreError(404, "Workspace not found");
    return workspace;
  }
  saveState(id: string, state: State): Workspace {
    const workspace = { ...this.requireWorkspace(id), state: StateSchema.parse(state), updatedAt: new Date().toISOString() };
    this.db.prepare("UPDATE workspaces SET data = ? WHERE id = ?").run(JSON.stringify(workspace), id);
    return workspace;
  }
  createPlan(workspaceId: string, plan: Plan): StoredPlan {
    this.requireWorkspace(workspaceId);
    const stored: StoredPlan = { ...PlanSchema.parse(plan), id: randomUUID(), workspaceId, status: "proposed", createdAt: new Date().toISOString(), results: [] };
    this.db.prepare("INSERT INTO plans VALUES (?, ?, ?)").run(stored.id, workspaceId, JSON.stringify(stored));
    return stored;
  }
  getPlan(workspaceId: string, id: string): StoredPlan | undefined {
    const row = this.db.prepare("SELECT data FROM plans WHERE id = ? AND workspace_id = ?").get(id, workspaceId) as JsonRow | undefined;
    return row ? JSON.parse(row.data) as StoredPlan : undefined;
  }
  listPlans(workspaceId: string): StoredPlan[] {
    return (this.db.prepare("SELECT data FROM plans WHERE workspace_id = ? ORDER BY rowid").all(workspaceId) as JsonRow[]).map((row) => JSON.parse(row.data));
  }
  savePlan(plan: StoredPlan): void {
    const result = this.db.prepare("UPDATE plans SET data = ? WHERE id = ? AND workspace_id = ?").run(JSON.stringify(plan), plan.id, plan.workspaceId);
    if (!result.changes) throw new StoreError(404, "Plan not found");
  }
  clearPlans(workspaceId: string): void {
    this.db.prepare("DELETE FROM plans WHERE workspace_id = ?").run(workspaceId);
  }
  appendLedger(input: LedgerInput): LedgerEvent {
    // Repeated delivery or recovery records the same transition only once. Status changes append a new row.
    const id = createHash("sha256").update(JSON.stringify([input.workspaceId, input.bookingId, input.kind, input.requestId, input.paypalId, input.status])).digest("hex");
    const event = { ...input, id, createdAt: new Date().toISOString() };
    this.db.prepare("INSERT OR IGNORE INTO ledger(id, workspace_id, paypal_id, capture_id, data) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.workspaceId, input.paypalId, input.captureId, JSON.stringify(event));
    return JSON.parse((this.db.prepare("SELECT data FROM ledger WHERE id = ?").get(id) as JsonRow).data);
  }
  listLedger(workspaceId: string): LedgerEvent[] {
    return (this.db.prepare("SELECT data FROM ledger WHERE workspace_id = ? ORDER BY seq").all(workspaceId) as JsonRow[]).map((row) => JSON.parse(row.data));
  }
  latestMoneyEvents(workspaceId: string): LedgerEvent[] {
    const latest = new Map<string, LedgerEvent>();
    for (const event of this.listLedger(workspaceId)) latest.set(`${event.kind}:${event.requestId}`, event);
    return [...latest.values()];
  }
  ledgerSummary(workspaceId: string): { captured: string; refunded: string; pending: string; simulatedCaptured: string; simulatedRefunded: string } {
    const totals = { captured: 0, refunded: 0, pending: 0, simulatedCaptured: 0, simulatedRefunded: 0 };
    for (const event of this.latestMoneyEvents(workspaceId)) {
      const amount = toCents(event.amount);
      if (event.kind === "capture" && event.status === "COMPLETED") totals.captured += amount;
      if (event.kind === "capture" && event.status === "SIMULATED") totals.simulatedCaptured += amount;
      if (event.kind === "refund" && event.status === "COMPLETED") totals.refunded += amount;
      if (event.kind === "refund" && event.status === "SIMULATED") totals.simulatedRefunded += amount;
      if (event.kind === "refund" && ["PENDING", "REQUESTED"].includes(event.status)) totals.pending += amount;
    }
    return Object.fromEntries(Object.entries(totals).map(([key, amount]) => [key, fromCents(amount)])) as ReturnType<Repository["ledgerSummary"]>;
  }
  findPayment(paypalId: string, captureId?: string): LedgerEvent | undefined {
    const row = this.db.prepare("SELECT data FROM ledger WHERE paypal_id = ? OR capture_id = ? ORDER BY (paypal_id = ?) DESC, seq DESC LIMIT 1")
      .get(paypalId, captureId ?? paypalId, paypalId) as JsonRow | undefined;
    return row ? JSON.parse(row.data) as LedgerEvent : undefined;
  }
  recordWebhook(id: string, rawBody: string): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO webhook_events VALUES (?, ?, ?)").run(id, rawBody, new Date().toISOString()).changes > 0;
  }
  getWebhook(id: string): string | undefined {
    return (this.db.prepare("SELECT raw_body FROM webhook_events WHERE id = ?").get(id) as { raw_body: string } | undefined)?.raw_body;
  }
  acquireLock(workspaceId: string): string {
    this.requireWorkspace(workspaceId);
    const owner = randomUUID();
    const result = this.db.prepare(`INSERT INTO workspace_locks VALUES (?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
      WHERE workspace_locks.expires_at < ?`).run(workspaceId, owner, Date.now() + 120_000, Date.now());
    if (!result.changes) throw new StoreError(409, "Workspace is busy; retry shortly");
    return owner;
  }
  renewLock(workspaceId: string, owner: string): void {
    const result = this.db.prepare("UPDATE workspace_locks SET expires_at = ? WHERE workspace_id = ? AND owner = ? AND expires_at >= ?")
      .run(Date.now() + 120_000, workspaceId, owner, Date.now());
    if (!result.changes) throw new StoreError(409, "Workspace execution lease expired");
  }
  releaseLock(workspaceId: string, owner: string): void {
    this.db.prepare("DELETE FROM workspace_locks WHERE workspace_id = ? AND owner = ?").run(workspaceId, owner);
  }
  pruneOlderThan(hours = 48): void {
    this.db.prepare("DELETE FROM workspaces WHERE created_at < ? AND id NOT IN (SELECT workspace_id FROM workspace_locks WHERE expires_at >= ?)")
      .run(new Date(Date.now() - hours * 3_600_000).toISOString(), Date.now());
  }
}

let shared: { directory: string; repository: Repository } | undefined;
export function getRepository(): Repository {
  const directory = resolve(/* turbopackIgnore: true */ process.env.DATA_DIR || "./.data");
  if (shared?.directory !== directory) {
    shared?.repository.close();
    shared = { directory, repository: new Repository(directory) };
  }
  return shared.repository;
}

export function closeRepository(): void {
  shared?.repository.close();
  shared = undefined;
}

export async function withWorkspaceLock<T>(repository: Repository, workspaceId: string, operation: (owner: string) => Promise<T> | T): Promise<T> {
  const owner = repository.acquireLock(workspaceId);
  try { return await operation(owner); }
  finally { repository.releaseLock(workspaceId, owner); }
}
