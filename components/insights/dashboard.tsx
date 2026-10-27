"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Insights } from "@/lib/insights/data";
import { observeInsights } from "../../lib/insights/refresh";
import { ReportBoundary } from "./report-boundary";
import ConsoleHeader from "../console/console-header";
import ExpiredDemo from "../console/expired-demo";

const StudioReport = dynamic(() => import("./studio-report"), { ssr: false, loading: () => <p className="insight-loading" role="status">Opening Studio insights…</p> });

export default function Dashboard({ id }: { id: string }) {
  const [data, setData] = useState<Insights>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useRef<() => void>(() => {});
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    // Keep the same object when nothing changed, so a focus refresh does not rebuild the Studio data or reset the analyst.
    const keepIfSame = (next: Insights) => setData((prev) => prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
    const observer = observeInsights(id, { data: keepIfSame, error: setError, expired: () => setExpired(true), loading: setLoading });
    refresh.current = () => { void observer.refresh(); };
    return () => observer.destroy();
  }, [id]);
  if (expired) return <ExpiredDemo />;
  return <main id="main-content" tabIndex={-1} className="insights-app">
    <ConsoleHeader workspaceId={id} name={data?.studio.name} week={data?.studio.week_label}><button disabled={loading} onClick={() => refresh.current()}>{loading ? "Refreshing…" : "Refresh"}</button><Link href={`/w/${id}`}>Back to schedule <span aria-hidden="true">↗</span></Link></ConsoleHeader>
    <div className="insights-heading"><div><p className="eyebrow">Your studio, in perspective</p><h1>Studio insights</h1></div><p className="muted">Workspace bookings, payments and recovery outcomes.</p></div>
    {error && <div className="insight-loading" role="alert"><p>{error}{data ? " Showing the last loaded records." : ""}</p><button disabled={loading} onClick={() => refresh.current()}>Try again</button></div>}
    {data ? <ReportBoundary key={id}><StudioReport id={id} data={data} /></ReportBoundary> : !error && <p className="insight-loading" role="status">Loading workspace records…</p>}
  </main>;
}
