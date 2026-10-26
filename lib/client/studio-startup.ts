export type StudioStartupPhase = "requesting" | "waking" | "preparing";

export function studioStartupMessage(phase: StudioStartupPhase): string {
  return phase === "waking" ? "Waking the studio up (free hosting, up to a minute)..."
    : phase === "preparing" ? "Preparing your studio..." : "Opening your studio...";
}

/** Stop the slow-request notice as soon as a response arrives or the view unmounts. */
export function watchStudioRequest(onSlow: () => void): () => void {
  const timer = setTimeout(onSlow, 3000);
  return () => clearTimeout(timer);
}
