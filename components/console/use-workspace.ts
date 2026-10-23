"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type WorkspaceResponse } from "@/lib/client/api";

export function useWorkspace(id: string, watchExecution: boolean) {
  const [workspace, setWorkspace] = useState<WorkspaceResponse>();
  const [error, setError] = useState("");
  const revision = useRef(0);
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
    async function poll() {
      const current = ++revision.current;
      try {
        const next = await api.workspace(id, controller.signal);
        if (controller.signal.aborted) return;
        if (current === revision.current) { setWorkspace(next); setError(""); }
        if (next.status === "preparing" || watchExecution || next.plans.some((plan) => plan.status === "executing")) timer = setTimeout(poll, 1000);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Unable to load this workspace.");
        timer = setTimeout(poll, 3000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, watchExecution, workspace?.status, executing]);
  return { workspace, error, refresh };
}
