"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { Insights } from "@/lib/insights/data";
import ConsoleHeader from "../console/console-header";
import ExpiredDemo from "../console/expired-demo";

const StudioReport = dynamic(() => import("./studio-report"), { ssr: false, loading: () => <p className="insight-loading" role="status">Opening Studio insights…</p> });

export default function Dashboard({ id }: { id: string }) {
  const [data, setData] = useState<Insights>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/workspaces/${encodeURIComponent(id)}/insights`, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      const body = await response.json();
      if (body.code === "expired") { setExpired(true); return; }
      if (!response.ok) throw new Error(body.error || "Could not load insights.");
      setData(body); setError("");
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load insights."); });
    return () => controller.abort();
  }, [id, retry]);
  if (expired) return <ExpiredDemo />;
  return <main id="main-content" tabIndex={-1} className="insights-app">
    <ConsoleHeader workspaceId={id} name={data?.studio.name} week={data?.studio.week_label}><Link href={`/w/${id}`}>Back to schedule <span aria-hidden="true">↗</span></Link></ConsoleHeader>
    <div className="insights-heading"><div><p className="eyebrow">Your studio, in perspective</p><h1>Studio insights</h1></div><p className="muted">Real bookings. Every recovery accounted for.</p></div>
    {error ? <div className="insight-loading" role="alert"><p>{error}</p><button onClick={() => setRetry((value) => value + 1)}>Try again</button></div> : data ? <StudioReport key={id} id={id} data={data} /> : <p className="insight-loading" role="status">Loading workspace records…</p>}
  </main>;
}
