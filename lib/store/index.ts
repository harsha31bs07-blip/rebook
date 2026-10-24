import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Plan, State } from "../domain/types";
import { PlanSchema, StateSchema } from "../domain/schemas";
import { addLocalDays, fromCents, localParts, toCents, zonedTimeToUtc } from "../domain/time";
import { nextWeekStart } from "../seed/seed";
import { activateConstraint, activeConstraints, preserveConstraints } from "../solver/constraints";

export type ExecutionResult = { bookingId: string; status: string; paypalId?: string; error?: string; debugId?: string };
export type StoredPlan = Plan & {
  id: string; workspaceId: string; status: "proposed" | "executing" | "executed" | "partially_failed";
  createdAt: string; results: ExecutionResult[]; basis?: State;
};
export type Workspace = {
  id: string; state: State; createdAt: string; updatedAt: string;
  status: "preparing" | "ready" | "failed"; progress: { done: number; total: number }; pooled?: true; preparationError?: string;
};
export type LedgerEvent = {
  id: string; workspaceId: string; bookingId: string; kind: "capture" | "refund";
  amount: string; paypalId: string; status: string; createdAt: string; debugId?: string; error?: string;
  requestId: string; captureId: string; firstAttemptAt?: string;
};
type LedgerInput = Omit<LedgerEvent, "id" | "createdAt">;
type JsonRow = { data: string };
export type CheckoutReservation = {
  id: string; workspaceId: string; requestId: string; sessionId: string;
  customer: { name: string; email: string }; amount: string; currency: "USD";
  session: State["sessions"][number]; expiresAt: number; orderId?: string; captureId?: string;
  status: "pending" | "capturing" | "confirmed" | "failed"; webhookConfirmed?: boolean;
};
const storeErrorBrand = Symbol.for("rebook.StoreError");
export class StoreError extends Error {
  readonly [storeErrorBrand] = true;
  // A repository/limiter shared through globalThis may come from Next's instrumentation bundle.
  static [Symbol.hasInstance](value: unknown): boolean {
    if (this !== StoreError) return Function.prototype[Symbol.hasInstance].call(this, value);
    return value instanceof Error && (value as StoreError)[storeErrorBrand] === true;
  }
  constructor(public status: number, message: string, public code?: string, public retryAfter?: number) { super(message); }
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
      CREATE TABLE IF NOT EXISTS checkout_reservations (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL, order_id TEXT UNIQUE, data TEXT NOT NULL, UNIQUE(workspace_id, request_id)
      );
    `);
  }
  close(): void { this.db.close(); }
  listCheckout(workspaceId: string): CheckoutReservation[] {
    return (this.db.prepare("SELECT data FROM checkout_reservations WHERE workspace_id = ?").all(workspaceId) as JsonRow[])
      .map((row) => JSON.parse(row.data));
  }
  checkoutByOrder(workspaceId: string, orderId: string): CheckoutReservation | undefined {
    return this.listCheckout(workspaceId).find((row) => row.orderId === orderId);
  }
  findCheckoutOrder(orderId: string): CheckoutReservation | undefined {
    const row = this.db.prepare("SELECT data FROM checkout_reservations WHERE order_id = ?").get(orderId) as JsonRow | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  saveCheckout(row: CheckoutReservation): void {
    this.db.prepare(`INSERT INTO checkout_reservations VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET order_id = excluded.order_id, data = excluded.data`)
      .run(row.id, row.workspaceId, row.requestId, row.orderId ?? null, JSON.stringify(row));
  }
  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  createWorkspace(state: State, id = randomBytes(8).toString("base64url").slice(0, 10), options: { preparing?: boolean; pooled?: true } = {}): Workspace {
    const now = new Date().toISOString();
    const workspace: Workspace = { id, state: preserveConstraints(state, StateSchema.parse(state)), createdAt: now, updatedAt: now,
      status: options.preparing ? "preparing" : "ready", progress: { done: options.preparing ? 0 : state.bookings.length, total: state.bookings.length },
      ...(options.pooled ? { pooled: true } : {}),
    };
    this.db.prepare("INSERT INTO workspaces VALUES (?, ?, ?)").run(id, JSON.stringify(workspace), now);
    return workspace;
  }
  getWorkspace(id: string, includePooled = false): Workspace | undefined {
    const row = this.db.prepare("SELECT data FROM workspaces WHERE id = ?").get(id) as JsonRow | undefined;
    if (!row) return undefined;
    const workspace = JSON.parse(row.data) as Workspace;
    if (workspace.pooled && !includePooled) return undefined;
    // Backfill workspaces executed before constraints were persisted in scheduling state.
    if (!activeConstraints(workspace.state).length) {
      const applied = this.db.prepare("SELECT data FROM plans WHERE workspace_id = ? AND json_extract(data, '$.status') != 'proposed'").all(id) as JsonRow[];
      for (const row of applied) workspace.state = activateConstraint(workspace.state, (JSON.parse(row.data) as StoredPlan).disruption);
    }
    // Older persisted workspaces predate the explicit seed-week field.
    if (!workspace.state.studio.weekStart) {
      const { timezone } = workspace.state.studio;
      const first = workspace.state.sessions.map((session) => session.start).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
      const local = first ? localParts(first, timezone) : undefined;
      workspace.state.studio.weekStart = local
        ? zonedTimeToUtc(addLocalDays(local.dateKey, -((local.weekday + 6) % 7)), "00:00", timezone)
        : nextWeekStart(workspace.createdAt, timezone);
    }
    // Workspaces persisted before background seeding was introduced were fully seeded.
    return { ...workspace, status: workspace.status ?? "ready",
      progress: workspace.progress ?? { done: workspace.state.bookings.length, total: workspace.state.bookings.length } };
  }
  requireWorkspace(id: string, includePooled = false): Workspace {
    const workspace = this.getWorkspace(id, includePooled);
    if (!workspace) throw new StoreError(404, "This demo has ended (demos reset when the server restarts). Start a fresh one.", "expired");
    return workspace;
  }
  requireReadyWorkspace(id: string): Workspace {
    const workspace = this.requireWorkspace(id);
    if (workspace.status !== "ready") throw new StoreError(409, "Workspace is not ready");
    return workspace;
  }
  savePreparation(id: string, status: Workspace["status"], progress: Workspace["progress"], error?: string): Workspace {
    this.updatePreparation(id, status, progress, error);
    return this.requireWorkspace(id, true);
  }
  updatePreparation(id: string, status: Workspace["status"], progress: Workspace["progress"], error?: string): void {
    this.db.prepare("UPDATE workspaces SET data = json_set(data, '$.status', ?, '$.progress', json(?), '$.updatedAt', ?, '$.preparationError', ?) WHERE id = ?")
      .run(status, JSON.stringify(progress), new Date().toISOString(), error ?? null, id);
  }
  stalePreparations(now = Date.now(), minimumAgeMs = 120_000): Workspace[] {
    return (this.db.prepare("SELECT data FROM workspaces WHERE json_extract(data, '$.status') = 'preparing' AND json_extract(data, '$.updatedAt') <= ?")
      .all(new Date(now - minimumAgeMs).toISOString()) as JsonRow[]).map((row) => JSON.parse(row.data));
  }
  readyPoolWorkspace(): Workspace | undefined {
    const rows = this.db.prepare("SELECT data FROM workspaces WHERE json_extract(data, '$.pooled') = 1 AND json_extract(data, '$.status') = 'ready' LIMIT 1").all() as JsonRow[];
    return rows[0] ? JSON.parse(rows[0].data) as Workspace : undefined;
  }
  poolStatus(): { ready: number; preparing: number } {
    const rows = this.db.prepare("SELECT json_extract(data, '$.status') AS status, COUNT(*) AS count FROM workspaces WHERE json_extract(data, '$.pooled') = 1 GROUP BY status")
      .all() as { status: string; count: number }[];
    return { ready: rows.find((row) => row.status === "ready")?.count ?? 0, preparing: rows.find((row) => row.status === "preparing")?.count ?? 0 };
  }
  claimPoolWorkspace(): Workspace | undefined {
    return this.transaction(() => {
      const now = new Date().toISOString();
      let pooled = this.readyPoolWorkspace();
      while (pooled && pooled.state.studio.weekStart !== nextWeekStart(now, pooled.state.studio.timezone)) {
        this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(pooled.id);
        pooled = this.readyPoolWorkspace();
      }
      if (!pooled) return undefined;
      const workspace = this.createWorkspace(pooled.state);
      for (const event of this.listLedger(pooled.id)) this.appendLedger({ ...event, workspaceId: workspace.id });
      this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(pooled.id);
      return workspace;
    });
  }
  saveState(id: string, state: State): Workspace {
    const workspace = { ...this.requireWorkspace(id, true), state: preserveConstraints(state, StateSchema.parse(state)), updatedAt: new Date().toISOString() };
    this.db.prepare("UPDATE workspaces SET data = ? WHERE id = ?").run(JSON.stringify(workspace), id);
    return workspace;
  }
  createPlan(workspaceId: string, plan: Plan): StoredPlan {
    this.requireWorkspace(workspaceId);
    const stored: StoredPlan = { ...PlanSchema.parse(plan), id: randomUUID(), workspaceId, status: "proposed", createdAt: new Date().toISOString(), results: [] };
    this.db.prepare("INSERT INTO plans VALUES (?, ?, ?)").run(stored.id, workspaceId, JSON.stringify(stored));
    // Only disposable proposals are evicted. Execution and payment history remains intact.
    this.db.prepare(`DELETE FROM plans WHERE id IN (
      SELECT p.id FROM plans p WHERE workspace_id = ? AND json_extract(data, '$.status') = 'proposed'
      AND NOT EXISTS (SELECT 1 FROM ledger l WHERE l.workspace_id = p.workspace_id AND json_extract(l.data, '$.requestId') LIKE p.id || ':%')
      ORDER BY rowid DESC LIMIT -1 OFFSET 20
    )`).run(workspaceId);
    return stored;
  }
  getPlan(workspaceId: string, id: string): StoredPlan | undefined {
    const row = this.db.prepare("SELECT data FROM plans WHERE id = ? AND workspace_id = ?").get(id, workspaceId) as JsonRow | undefined;
    return row ? this.planView(JSON.parse(row.data) as StoredPlan) : undefined;
  }
  listPlans(workspaceId: string, limit?: number): StoredPlan[] {
    const rows = limit === undefined
      ? this.db.prepare("SELECT data FROM plans WHERE workspace_id = ? ORDER BY rowid").all(workspaceId)
      : this.db.prepare("SELECT data FROM (SELECT rowid AS position, data FROM plans WHERE workspace_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY position").all(workspaceId, limit);
    return (rows as JsonRow[]).map((row) => this.planView(JSON.parse(row.data)));
  }
  private planView(plan: StoredPlan): StoredPlan {
    if (plan.status === "proposed") return plan;
    const latest = this.latestMoneyEvents(plan.workspaceId);
    const results = plan.bookingActions.filter((action) => action.action === "refund").map((action): ExecutionResult => {
      const event = latest.find((item) => item.kind === "refund" && item.requestId === `${plan.id}:${action.bookingId}`);
      return event ? { bookingId: action.bookingId, status: event.status, paypalId: event.paypalId || undefined,
        debugId: event.debugId, error: event.error ?? (["FAILED", "REQUESTED"].includes(event.status)
          ? plan.results.find((item) => item.bookingId === action.bookingId)?.error : undefined) }
        : { bookingId: action.bookingId, status: "REQUESTED", error: "Refund has not been submitted yet" };
    });
    const status = plan.status === "executing" ? "executing" : results.some((item) => !["COMPLETED", "SIMULATED", "PENDING"].includes(item.status))
      ? "partially_failed" : "executed";
    return { ...plan, results, status };
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
    const previous = this.latestMoneyEvents(input.workspaceId).find((event) => event.kind === input.kind && event.requestId === input.requestId);
    if (previous && previous.paypalId === input.paypalId && previous.status === input.status && previous.error === input.error) return previous;
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    // Keep the original replay deadline across transitions and process restarts.
    const event = { ...input, id, createdAt, ...(input.kind === "capture" ? {
      firstAttemptAt: previous?.firstAttemptAt ?? this.listLedger(input.workspaceId)
        .find((event) => event.kind === "capture" && event.requestId === input.requestId)?.createdAt ?? input.firstAttemptAt ?? createdAt,
    } : {}) };
    this.db.prepare("INSERT OR IGNORE INTO ledger(id, workspace_id, paypal_id, capture_id, data) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.workspaceId, input.paypalId, input.captureId, JSON.stringify(event));
    return JSON.parse((this.db.prepare("SELECT data FROM ledger WHERE id = ?").get(id) as JsonRow).data);
  }
  listLedger(workspaceId: string, limit?: number): LedgerEvent[] {
    const rows = limit === undefined
      ? this.db.prepare("SELECT data FROM ledger WHERE workspace_id = ? ORDER BY seq").all(workspaceId)
      : this.db.prepare("SELECT data FROM (SELECT seq, data FROM ledger WHERE workspace_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq").all(workspaceId, limit);
    return (rows as JsonRow[]).map((row) => JSON.parse(row.data));
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
    this.requireWorkspace(workspaceId, true);
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
  pruneOlderThan(hours = 24): void {
    this.transaction(() => {
      const candidates = this.db.prepare(`SELECT id FROM workspaces WHERE created_at < ?
        AND COALESCE(json_extract(data, '$.status'), 'ready') != 'preparing'
        AND id NOT IN (SELECT workspace_id FROM workspace_locks WHERE expires_at >= ?)
        AND id NOT IN (SELECT workspace_id FROM plans WHERE json_extract(data, '$.status') = 'executing')`)
        .all(new Date(Date.now() - hours * 3_600_000).toISOString(), Date.now()) as { id: string }[];
      for (const { id } of candidates) {
        // A timed-out capture can still have charged the buyer; keep its recovery reference.
        if (this.listCheckout(id).some((row) => row.status === "capturing" || (row.status === "pending" && row.expiresAt > Date.now()))) continue;
        if (this.latestMoneyEvents(id).some((event) => ["REQUESTED", "PENDING", "UNKNOWN"].includes(event.status))) continue;
        this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
      }
      // Keep event IDs for deduplication; only the retained raw payload expires.
      this.db.prepare("UPDATE webhook_events SET raw_body = '' WHERE received_at < ? AND raw_body != ''")
        .run(new Date(Date.now() - 7 * 86_400_000).toISOString());
    });
  }
}

// Instrumentation and route handlers can load separate bundles in the same Next.js process.
const processStore = globalThis as typeof globalThis & { rebookStore?: { directory: string; repository: Repository } };
export function getRepository(): Repository {
  const directory = resolve(/* turbopackIgnore: true */ process.env.DATA_DIR || "./.data");
  let shared = processStore.rebookStore;
  if (shared?.directory !== directory) {
    shared?.repository.close();
    shared = { directory, repository: new Repository(directory) };
    processStore.rebookStore = shared;
  }
  return shared.repository;
}

export function closeRepository(): void {
  processStore.rebookStore?.repository.close();
  processStore.rebookStore = undefined;
}

const pruning = globalThis as typeof globalThis & { rebookPruneTimer?: ReturnType<typeof setInterval> };
export function startPruning(): void {
  if (pruning.rebookPruneTimer) return;
  getRepository().pruneOlderThan();
  pruning.rebookPruneTimer = setInterval(() => {
    try { getRepository().pruneOlderThan(); } catch { console.error("Demo cache pruning failed"); }
  }, 30 * 60_000);
  pruning.rebookPruneTimer.unref();
}

export async function withWorkspaceLock<T>(repository: Repository, workspaceId: string, operation: (owner: string) => Promise<T> | T): Promise<T> {
  const owner = repository.acquireLock(workspaceId);
  // Slow reconciliation/payment requests must not let another writer steal the lease.
  const heartbeat = setInterval(() => {
    try { repository.renewLock(workspaceId, owner); }
    catch { /* The next explicit renewal fences a writer whose lease was lost. */ }
  }, 30_000);
  heartbeat.unref();
  try { return await operation(owner); }
  finally { clearInterval(heartbeat); repository.releaseLock(workspaceId, owner); }
}
