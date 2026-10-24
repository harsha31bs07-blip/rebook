"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client/api";

export default function OpenDemoButton({ label = "Open the live demo" }: { label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function open() {
    setBusy(true); setError("");
    try { const { id } = await api.create(); router.push(`/w/${id}`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to start the demo."); setBusy(false); }
  }
  return <div><button className="primary demo-button" onClick={() => void open()} disabled={busy}>{busy ? "Opening your studio…" : label}<span aria-hidden="true">→</span></button>{error && <p className="error" role="alert">{error}</p>}<span className="sr-only" role="status">{busy ? "Creating your demo workspace" : ""}</span></div>;
}
