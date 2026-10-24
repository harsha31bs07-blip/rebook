"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type WorkspaceResponse } from "@/lib/client/api";

function hasPendingRefunds(workspace?: WorkspaceResponse): boolean {
  const latest = new Map<string, string>();
  for (const event of workspace?.ledger ?? []) if (event.kind === "refund") latest.set(event.requestId, event.status);
  return [...latest.values()].some((status) => ["PENDING", "REQUESTED"].includes(status));
}

export function useWorkspace(id: string, watchExecution: boolean) {
  const [workspace, setWorkspace] = useState<WorkspaceResponse>();
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [bookingNotice, setBookingNotice] = useState<{ message: string; sessionId: string }>();
  const previous = useRef<WorkspaceResponse | undefined>(undefined);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const receive = useCallback((next: WorkspaceResponse) => {
    if (previous.current?.id === next.id && previous.current.status === "ready") {
      const ids = new Set(previous.current.state.bookings.map((booking) => booking.id));
      const booking = next.state.bookings.find((booking) => !ids.has(booking.id) && booking.payment && !booking.payment.simulated);
      const session = next.state.sessions.find((session) => session.id === booking?.sessionId);
      const customer = next.state.customers.find((customer) => customer.id === booking?.customerId);
      if (booking && session && customer) {
        const when = new Intl.DateTimeFormat("en-GB", { timeZone: next.state.studio.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(session.start)).replace(",", "");
        setBookingNotice({ sessionId: session.id, message: `New booking: ${customer.name} · ${session.title} ${when} · $${booking.amount} via PayPal` });
        clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => setBookingNotice(undefined), 8000);
      }
    }
    previous.current = next;
    setWorkspace(next); setError("");
  }, []);
  const revision = useRef(0);
  const pending = hasPendingRefunds(workspace);
  const executing = workspace?.plans.some((plan) => plan.status === "executing") ?? false;
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    let next: WorkspaceResponse;
    try { next = await api.workspace(id); }
    catch (cause) { if (cause instanceof ApiError && cause.code === "expired") setExpired(true); throw cause; }
    if (current === revision.current) receive(next);
    return next;
  }, [id, receive]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const current = ++revision.current;
      try {
        const next = await api.workspace(id, controller.signal);
        if (controller.signal.aborted) return;
        if (current === revision.current) receive(next);
        const unresolved = next.plans.some((plan) => plan.status === "executing") || hasPendingRefunds(next);
        timer = setTimeout(poll, next.status === "preparing" || watchExecution || unresolved ? 3000 : 5000);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.code === "expired") { setExpired(true); return; }
        setError(cause instanceof Error ? cause.message : "Unable to load this workspace.");
        timer = setTimeout(poll, 5000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, watchExecution, workspace?.status, executing, pending, receive]);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  return { workspace, error, refresh, expired, bookingNotice };
}
