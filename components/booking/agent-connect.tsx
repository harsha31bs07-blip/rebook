"use client";

import { useState, useSyncExternalStore } from "react";

const noSubscription = () => () => {};

/** How a customer's own AI assistant connects to this studio (remote MCP); payment always stays with the person. */
export default function AgentConnect({ bookingId, owner = false }: { bookingId: string; owner?: boolean }) {
  const origin = useSyncExternalStore(noSubscription, () => window.location.origin, () => ""), [message, setMessage] = useState("");
  const url = `${origin}/api/mcp/${bookingId}`;
  async function copy() {
    try { await navigator.clipboard.writeText(url); setMessage("Copied."); }
    catch { setMessage("Copy was unavailable. Select and copy the address."); }
  }
  return <section className="agent-connect" aria-labelledby={`agent-connect-${owner ? "owner" : "public"}`}>
    <h3 id={`agent-connect-${owner ? "owner" : "public"}`}>{owner ? "AI agents" : "Book with your AI assistant"}</h3>
    <p className="muted">{owner ? "Customers' own AI assistants can find classes, book, join a waitlist or answer a rebooking link here. They never pay: each booking returns a PayPal link the customer approves, and refunds need the customer's confirmation."
      : "Add this studio to Claude, ChatGPT or any MCP-capable assistant. It can find a class and hold your seat; you approve the payment yourself on PayPal."}</p>
    <p><code>{origin ? url : `/api/mcp/${bookingId}`}</code> <button type="button" onClick={() => void copy()} disabled={!origin}>Copy address</button></p>
    <p role="status" className="muted">{message}</p>
    <a href="https://github.com/harsha31bs07-blip/rebook/blob/main/docs/agents.md" target="_blank" rel="noreferrer">How it works</a>
  </section>;
}
