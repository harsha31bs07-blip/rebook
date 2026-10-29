"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";

export const JUDGE_HINT_KEY = "rebook:judge-hint:dismissed";
function dismissed() {
  try { return localStorage.getItem(JUDGE_HINT_KEY) === "1"; } catch { return false; }
}
function subscribe(notify: () => void) {
  window.addEventListener("storage", notify);
  return () => window.removeEventListener("storage", notify);
}
export function dismissJudgeHint() {
  try { localStorage.setItem(JUDGE_HINT_KEY, "1"); } catch { /* Dismiss for this visit if storage is disabled. */ }
}

export default function JudgeHint({ id, ready, preview, hasPlan, onStep }: {
  id: string; ready: boolean; preview: boolean; hasPlan: boolean;
  onStep: (step: "example" | "plan" | "move" | "approve" | "messages") => void;
}) {
  const saved = useSyncExternalStore(subscribe, dismissed, () => false);
  const [hidden, setHidden] = useState(false);
  if (saved || hidden) return null;
  return <section className="judge-hint" aria-label="Try it in 60 seconds">
    <div><strong>Try it in 60 seconds</strong><button aria-label="Dismiss quick tour" onClick={() => { dismissJudgeHint(); setHidden(true); }}>×</button></div>
    <ol>
      {/* Tour buttons jump to a step; their spoken names must not duplicate the real action buttons. */}
      <li><button aria-label="Tour step 1: pick an example" disabled={!ready || hasPlan} onClick={() => onStep("example")}>Pick an example</button></li>
      <li><button aria-label="Tour step 2: go to Plan recovery" disabled={!ready || hasPlan} onClick={() => onStep("plan")}>Plan recovery</button></li>
      <li><button aria-label="Tour step 3: move a class (optional)" disabled={!preview} onClick={() => onStep("move")}>Move a class (optional)</button></li>
      <li><button aria-label="Tour step 4: go to Approve and refund" disabled={!preview} onClick={() => onStep("approve")}>Approve and refund</button></li>
      <li><button aria-label="Tour step 5: open a customer link from Messages" disabled={!hasPlan} onClick={() => onStep("messages")}>Open a customer link from Messages</button></li>
      <li><span className="muted">Under What happens next, see Alex’s page and pay his cover with PayPal</span></li>
      <li><Link href={`/w/${id}/dashboard#recovery-analyst`}>Dashboard → Ask Recovery analyst</Link></li>
    </ol>
  </section>;
}
