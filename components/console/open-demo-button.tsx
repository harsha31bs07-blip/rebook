"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { studioStartupMessage, watchStudioRequest, type StudioStartupPhase } from "../../lib/client/studio-startup";

export default function OpenDemoButton({ label = "Open the live demo", destination = "console" }: { label?: string; destination?: "console" | "booking" | "dashboard" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<StudioStartupPhase>("requesting");
  const [retrySeconds, setRetrySeconds] = useState(0);
  const stopWaiting = useRef<(() => void) | undefined>(undefined);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const countdown = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const inFlight = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; stopWaiting.current?.(); clearTimeout(retryTimer.current); clearInterval(countdown.current); };
  }, []);
  async function open() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError("");
    await attempt(false);
  }
  async function attempt(retried: boolean) {
    setPhase("requesting");
    stopWaiting.current = watchStudioRequest(() => setPhase("waking"));
    try { const { id } = await api.create(); if (!active.current) return; stopWaiting.current(); setPhase("preparing"); router.push(`/w/${id}${destination === "booking" ? "/book" : destination === "dashboard" ? "/dashboard" : ""}`); }
    catch (cause) {
      if (!active.current) return;
      if (cause instanceof ApiError && cause.status === 429 && !retried) {
        const seconds = cause.retryAfter ?? 8;
        setError(cause.message); setRetrySeconds(seconds);
        countdown.current = setInterval(() => setRetrySeconds((remaining) => Math.max(0, remaining - 1)), 1000);
        retryTimer.current = setTimeout(() => {
          clearInterval(countdown.current); setRetrySeconds(0); setError("");
          void attempt(true);
        }, seconds * 1000);
      } else {
        setError(cause instanceof ApiError && cause.status === 429
          ? `${cause.message}${cause.retryAfter ? `. Try again in ${cause.retryAfter} s.` : ". Please retry shortly."}`
          : "We couldn't open the studio. Please retry.");
        setBusy(false); inFlight.current = false;
      }
    }
    finally { stopWaiting.current?.(); }
  }
  const progress = retrySeconds > 0 ? `${error.replace(/[.!]$/, "")}, retrying in ${retrySeconds} s` : studioStartupMessage(phase);
  return <div><button className="primary demo-button" onClick={() => void open()} disabled={busy} aria-busy={busy}>{busy ? progress : error ? "Retry opening the demo" : label}<span aria-hidden="true">→</span></button>{error && retrySeconds === 0 && <p className="error" role="alert">{error}</p>}<span className="sr-only" role="status">{busy ? progress : ""}</span></div>;
}
