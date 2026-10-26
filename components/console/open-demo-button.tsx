"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { studioStartupMessage, watchStudioRequest, type StudioStartupPhase } from "../../lib/client/studio-startup";

export default function OpenDemoButton({ label = "Open the live demo", destination = "console" }: { label?: string; destination?: "console" | "booking" | "dashboard" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<StudioStartupPhase>("requesting");
  const stopWaiting = useRef<(() => void) | undefined>(undefined);
  const inFlight = useRef(false);
  useEffect(() => () => stopWaiting.current?.(), []);
  async function open() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError("");
    setPhase("requesting");
    stopWaiting.current = watchStudioRequest(() => setPhase("waking"));
    try { const { id } = await api.create(); stopWaiting.current(); setPhase("preparing"); router.push(`/w/${id}${destination === "booking" ? "/book" : destination === "dashboard" ? "/dashboard" : ""}`); }
    catch { setError("We couldn't open the studio. Please retry."); setBusy(false); inFlight.current = false; }
    finally { stopWaiting.current?.(); }
  }
  return <div><button className="primary demo-button" onClick={() => void open()} disabled={busy} aria-busy={busy}>{busy ? studioStartupMessage(phase) : error ? "Retry opening the demo" : label}<span aria-hidden="true">→</span></button>{error && <p className="error" role="alert">{error}</p>}<span className="sr-only" role="status">{busy ? studioStartupMessage(phase) : ""}</span></div>;
}
