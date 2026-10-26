"use client";

import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { api, type PlanDetails, type PublicPlan, type WorkspaceResponse } from "../../lib/client/api";
import type { State } from "../../lib/domain/types";

export function latestProposedPlan(plans: PublicPlan[]): PublicPlan | undefined {
  return plans.toReversed().find((plan) => plan.status === "proposed");
}

export function usePlanPreview(id: string, workspace?: WorkspaceResponse) {
  const [details, updateDetails] = useState<PlanDetails>();
  const [basis, setBasis] = useState<State>();
  const [restoreError, setRestoreError] = useState("");
  const attempted = useRef(false);
  const pending = useRef<AbortController | undefined>(undefined);
  const setDetails = useCallback((value: SetStateAction<PlanDetails | undefined>) => {
    pending.current?.abort();
    updateDetails(value);
    setRestoreError("");
  }, []);
  const restore = useCallback(async () => {
    const proposal = workspace && latestProposedPlan(workspace.plans);
    if (!proposal || !workspace) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    try {
      const next = await api.details(id, proposal.id, controller.signal);
      if (controller.signal.aborted || next.plan.status !== "proposed") return;
      setBasis({ ...workspace.state, sessions: next.sessions });
      updateDetails(next); setRestoreError("");
    } catch {
      if (!controller.signal.aborted) setRestoreError("Your saved preview couldn't be opened. Retry to restore it.");
    }
  }, [id, workspace]);
  useEffect(() => {
    if (workspace?.status !== "ready" || attempted.current) return;
    attempted.current = true;
    void restore();
  }, [workspace?.status, restore]);
  useEffect(() => () => { pending.current?.abort(); attempted.current = false; }, []);
  return { details, setDetails, basis, setBasis, restoreError, restore };
}
