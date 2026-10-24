"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type WorkspaceResponse } from "@/lib/client/api";

function hasPendingRefunds(workspace?: WorkspaceResponse): boolean {
  const latest = new Map<string, string>();
  for (const event of workspace?.ledger ?? []) if (event.kind === "refund") latest.set(event.requestId, event.status);
  return [...latest.values()].some((status) => ["PENDING", "REQUESTED"].includes(status));
}

export function useWorkspace(id: string, watchExecution: boolean) {
  const [workspace, setWorkspace] = useState<WorkspaceResponse>();
  const [error, setError] = useState("");
  const revision = useRef(0);
  const pending = hasPendingRefunds(workspace);
  const executing = workspace?.plans.some((plan) => plan.status === "executing") ?? false;
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    const next = await api.workspace(id);
    if (current === revision.current) { setWorkspace(next); setError(""); }
    return next;
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 120_000;
    async function poll() {
      const current = ++revision.current;
      try {
        const next = await api.workspace(id, controller.signal);
        if (controller.signal.aborted) return;
        if (current === revision.current) { setWorkspace(next); setError(""); }
        const unresolved = next.plans.some((plan) => plan.status === "executing") || hasPendingRefunds(next);
        if (Date.now() < deadline && (next.status === "preparing" || watchExecution || unresolved)) timer = setTimeout(poll, 3000);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Unable to load this workspace.");
        if (Date.now() < deadline) timer = setTimeout(poll, 3000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, watchExecution, workspace?.status, executing, pending]);
  return { workspace, error, refresh };
}
