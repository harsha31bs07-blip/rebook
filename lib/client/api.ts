import type { OwnerAdjustment } from "../solver/adjust";
import type { Interpretation } from "../ai/interpret";
import type { PlanExplanation } from "../ai/explain";
import type { CustomerMessage } from "../ai/messages";
import type { Disruption } from "../domain/types";
import type { ExecutionResult, LedgerEvent, StoredPlan, Workspace } from "../store";
import type { OwnerCustomerChoices } from "../choices/service";
import type { PaymentAttention } from "../recovery/payment-attention";

export type PublicPlan = Omit<StoredPlan, "basis">;
export type WorkspaceResponse = Workspace & {
  plans: PublicPlan[];
  ledger: LedgerEvent[];
  ledgerSummary: Record<string, unknown>;
  customerChoices?: OwnerCustomerChoices;
  paymentsNeedingAttention?: PaymentAttention[];
};
export type PlanDetails = { plan: PublicPlan; explanation: PlanExplanation; messages: CustomerMessage[]; sessions: Workspace["state"]["sessions"] };
export type { Interpretation, ExecutionResult };

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public retryAfter?: number) { super(message); }
}

async function request<T>(path: string, body?: object, signal?: AbortSignal, method?: string, keepalive = false): Promise<T> {
  const response = await fetch(`/api/workspaces${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store", signal, keepalive,
  });
  const data = await response.json();
  if (!response.ok) {
    const header = response.headers.get("Retry-After");
    const seconds = header === null ? NaN : /^\d+$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
    throw new ApiError(response.status, data.message ?? data.error ?? "Something went wrong. Please try again.", data.code,
      Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : undefined);
  }
  return data as T;
}

const workspacePath = (id: string) => `/${encodeURIComponent(id)}`;
export const api = {
  create: () => request<{ id: string }>("", {}),
  workspace: (id: string, signal?: AbortSignal) => request<WorkspaceResponse>(workspacePath(id), undefined, signal),
  interpret: (id: string, text: string, signal?: AbortSignal) => request<Interpretation>(`${workspacePath(id)}/interpret`, { text }, signal),
  plan: (id: string, disruption: Disruption, signal?: AbortSignal) => request<PublicPlan>(`${workspacePath(id)}/plans`, { disruption }, signal),
  details: (id: string, planId: string, signal?: AbortSignal) => request<PlanDetails>(`${workspacePath(id)}/plans/${encodeURIComponent(planId)}`, undefined, signal),
  discard: (id: string, planId: string) => request<{ discarded: true }>(`${workspacePath(id)}/plans/${encodeURIComponent(planId)}`, undefined, undefined, "DELETE"),
  adjust: (id: string, planId: string, input: OwnerAdjustment | { undo: true }, version: number) => request<PublicPlan>(`${workspacePath(id)}/plans/${encodeURIComponent(planId)}/adjust`, { ...input, version }),
  approve: (id: string, planId: string, version = 1, confirmedCoverSessionIds: string[] = []) => request<{ plan: PublicPlan; results: ExecutionResult[] }>(`${workspacePath(id)}/plans/${encodeURIComponent(planId)}/approve`, { version, confirmedCoverSessionIds }),
  checkRefund: (id: string, requestId: string) => request<{ kind: "found" | "absent" | "unknown" | "settled" }>(`${workspacePath(id)}/refunds/check`, { requestId }),
  retryRefund: (id: string, requestId: string) => request<{ status: string }>(`${workspacePath(id)}/refunds/retry`, { requestId }),
  reset: (id: string) => request<{ id: string }>(`${workspacePath(id)}/reset`, {}),
  contact: (id: string, planId: string, customerId: string, sent: boolean) => request<OwnerCustomerChoices>(`${workspacePath(id)}/outbox`, { planId, customerId, sent }, undefined, undefined, true),
};
