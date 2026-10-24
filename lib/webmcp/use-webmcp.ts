"use client";

import { useEffect, useRef } from "react";
import { createWebMcpBridge, type WebMcpTool } from "./bridge";

export function useWebMcp(tools: readonly WebMcpTool[] | (() => readonly WebMcpTool[])) {
  const bridge = useRef<ReturnType<typeof createWebMcpBridge> | undefined>(undefined);
  useEffect(() => {
    const mounted = createWebMcpBridge();
    bridge.current = mounted;
    return () => { mounted.destroy(); bridge.current = undefined; };
  }, []);
  useEffect(() => { void bridge.current?.sync(typeof tools === "function" ? tools() : tools); }, [tools]);
}
