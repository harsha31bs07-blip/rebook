import Link from "next/link";
import type { ReactNode } from "react";
import AgentReadyChip from "../webmcp/agent-ready-chip";

export default function ConsoleHeader({ name, week, workspaceId, children }: { name?: string; week?: string; workspaceId?: string; children: ReactNode }) {
  return <header className="console-header">
    <Link href="/" className="wordmark" aria-label="Rebook home"><span className="brand-symbol" aria-hidden="true">r</span>rebook<span className="wordmark-dot">.</span></Link>
    <div className="header-divider" /><div className="studio-heading"><strong>{name ?? "Your studio"}</strong><span>{week ?? "Loading your week…"}</span></div>
    <div className="header-actions"><Link href={workspaceId ? `/built-with?workspace=${encodeURIComponent(workspaceId)}` : "/built-with"}>How it&apos;s built</Link><AgentReadyChip /><span className="pill sandbox"><span />PayPal sandbox</span>{children}</div>
  </header>;
}
