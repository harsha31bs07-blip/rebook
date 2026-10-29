import { z } from "zod";
import type { Repository } from "../store";
import { MoneySchema } from "../domain/schemas";
import { toCents } from "../domain/time";
import { getPayout } from "./payouts";

export type MoneyVerificationItem = {
  kind: "refund" | "payout"; label: string; amount: string; currency: string;
  rebook: string; paypal: string; source: "PayPal Agent Toolkit" | "Payouts API";
  match: "match" | "paypal-ahead" | "mismatch" | "not-found" | "unavailable";
};
export type MoneyVerification = {
  checkedAt: string; items: MoneyVerificationItem[];
  summary: { checked: number; matched: number; mismatched: number; unavailable: number };
};

// Imported only on a verification request. Never expose credentials or upstream error text.
let toolkit: Promise<InstanceType<typeof import("@paypal/agent-toolkit/openai").PayPalAgentToolkit>> | undefined;
function readToolkit() {
  if ((process.env.PAYPAL_ENV ?? "sandbox") !== "sandbox") throw new Error("Sandbox only");
  const clientId = process.env.PAYPAL_CLIENT_ID, clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("PayPal unavailable");
  toolkit ??= import("@paypal/agent-toolkit/openai").then(({ PayPalAgentToolkit }) => new PayPalAgentToolkit({
    clientId, clientSecret, configuration: {
      actions: { payments: { getRefunds: true }, transactions: { list: true }, orders: { get: true } },
      context: { sandbox: true, debug: false },
    },
  })).catch(() => { toolkit = undefined; throw new Error("PayPal unavailable"); });
  return toolkit;
}

const RefundSchema = z.object({ id: z.string().optional(), status: z.string().min(1),
  amount: z.object({ value: MoneySchema, currency_code: z.string() }) });
function notFound(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const error = value as Record<string, unknown>;
  return error.status === 404 || error.statusCode === 404 || error.name === "RESOURCE_NOT_FOUND"
    || notFound(error.error) || notFound(error.response);
}
const timeout = Symbol("verification timeout");
async function bounded<T>(operation: () => Promise<T>, ms: number): Promise<T | typeof timeout> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<typeof timeout>((resolve) => {
      timer = setTimeout(() => resolve(timeout), Math.max(0, ms));
    })]);
  } finally { clearTimeout(timer); }
}

/** Compare snapshots only. Reconciliation and all ledger writes belong to the existing payment flow. */
export async function verifyWorkspaceMoney(workspaceId: string, repository: Repository): Promise<MoneyVerification> {
  const deadline = Date.now() + 30_000;
  const { state } = repository.requireReadyWorkspace(workspaceId);
  const tasks: { item: MoneyVerificationItem; run: () => Promise<Pick<MoneyVerificationItem, "paypal" | "match">> }[] = [];
  for (const event of repository.latestMoneyEvents(workspaceId).filter((row) => row.kind === "refund" && row.paypalId && ["COMPLETED", "PENDING"].includes(row.status))) {
    const booking = state.bookings.find((row) => row.id === event.bookingId);
    const customer = state.customers.find((row) => row.id === booking?.customerId);
    const session = state.sessions.find((row) => row.id === booking?.sessionId);
    const item: MoneyVerificationItem = { kind: "refund", label: `${customer?.name ?? "Customer"} · ${session?.title ?? "Class unavailable"}`,
      amount: event.amount, currency: state.studio.currency, rebook: event.status, paypal: "Unavailable", source: "PayPal Agent Toolkit", match: "unavailable" };
    tasks.push({ item, run: async () => {
      const reader = await readToolkit();
      const response = await reader.handleToolCall({ id: `verify-${event.id}`, type: "function",
        function: { name: "get_refund", arguments: JSON.stringify({ refund_id: event.paypalId }) } });
      if (typeof response.content !== "string") throw new Error("Invalid refund response");
      const body: unknown = JSON.parse(response.content);
      if (notFound(body)) return { paypal: "Not found", match: "not-found" };
      const refund = RefundSchema.parse(body);
      const moneyMatches = toCents(refund.amount.value) === toCents(event.amount) && refund.amount.currency_code === item.currency
        && (!refund.id || refund.id === event.paypalId);
      return { paypal: refund.status, match: !moneyMatches ? "mismatch" : refund.status === event.status ? "match"
        : event.status === "PENDING" && refund.status === "COMPLETED" ? "paypal-ahead" : "mismatch" };
    } });
  }
  for (const payout of repository.listCoverPayouts(workspaceId).filter((row) => row.batchId)) {
    const instructor = state.instructors.find((row) => row.id === payout.instructorId);
    const session = state.sessions.find((row) => row.id === payout.sessionId);
    const item: MoneyVerificationItem = { kind: "payout", label: `${instructor?.name ?? "Instructor"} · ${session?.title ?? "Class unavailable"}`,
      amount: payout.amount, currency: state.studio.currency, rebook: payout.status, paypal: "Unavailable", source: "Payouts API", match: "unavailable" };
    tasks.push({ item, run: async () => {
      const remote = await getPayout(payout.batchId!);
      const status = remote.batchStatus === "DENIED" ? "DENIED" : remote.itemStatus;
      if (!status) throw new Error("Payout status unavailable");
      // getPayout reads one cover fee's item. A successful batch alone does not prove its item was paid.
      const amount = z.object({ value: MoneySchema, currency: z.string().min(1) }).parse(remote.amount);
      const moneyMatches = toCents(amount.value) === toCents(payout.amount) && amount.currency === item.currency;
      return { paypal: status, match: !moneyMatches ? "mismatch" : status === payout.status ? "match"
        : payout.status === "PENDING" && status === "SUCCESS" ? "paypal-ahead" : "mismatch" };
    } });
  }
  let next = 0;
  async function worker() {
    while (next < tasks.length && Date.now() < deadline) {
      const task = tasks[next++];
      try {
        const result = await bounded(task.run, Math.min(10_000, deadline - Date.now()));
        // Toolkit calls cannot be aborted. Retire this slot after a timeout so at most three
        // actual upstream calls remain in flight, including calls that outlive the response.
        if (result === timeout) return;
        Object.assign(task.item, result);
      } catch (error) {
        if (notFound(error)) Object.assign(task.item, { paypal: "Not found", match: "not-found" });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, worker));
  const items = tasks.map(({ item }) => item);
  return { checkedAt: new Date().toISOString(), items, summary: { checked: items.length,
    matched: items.filter((row) => row.match === "match" || row.match === "paypal-ahead").length,
    mismatched: items.filter((row) => row.match === "mismatch" || row.match === "not-found").length,
    unavailable: items.filter((row) => row.match === "unavailable").length } };
}
