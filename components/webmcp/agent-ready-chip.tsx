"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { detectModelContext, subscribeTools, toolSnapshot } from "../../lib/webmcp/bridge";

const snapshot = () => detectModelContext() ? `supported:${toolSnapshot()}` : "";
const serverSnapshot = () => "";

export default function AgentReadyChip() {
  const status = useSyncExternalStore(subscribeTools, snapshot, serverSnapshot);
  if (!status) return null;
  const tools = status.slice("supported:".length);
  return <Link className="pill agent-ready-chip" href="/agent-ready" title={tools ? `Available tools: ${tools}` : "WebMCP detected. Tools appear when this page is ready."}>Agent-ready<span className="sr-only">. {tools ? `Available tools: ${tools}` : "Tools loading"}</span></Link>;
}
