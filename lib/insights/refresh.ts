import type { Insights } from "./data";

type Callbacks = { data(value: Insights): void; error(message: string): void; expired(): void; loading(value: boolean): void };

/** One request at a time; focus and visibility events share a debounce and cooldown. */
export function observeInsights(id: string, callbacks: Callbacks, win: Pick<Window, "addEventListener" | "removeEventListener"> = window,
  doc: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState"> = document) {
  const controller = new AbortController();
  let pending = false;
  let refreshAfterPending = false;
  let lastStarted = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    if (pending || controller.signal.aborted) return;
    clearTimeout(timer);
    pending = true;
    lastStarted = Date.now();
    callbacks.loading(true);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(id)}/insights`, { signal: controller.signal, cache: "no-store" });
      const body = await response.json();
      if (controller.signal.aborted) return;
      if (body.code === "expired") { callbacks.expired(); return; }
      if (!response.ok) throw new Error(body.error || "Could not load insights.");
      callbacks.data(body);
      callbacks.error("");
    } catch (cause) {
      if (!controller.signal.aborted) callbacks.error(cause instanceof Error ? cause.message : "Could not load insights.");
    } finally {
      pending = false;
      if (!controller.signal.aborted) {
        callbacks.loading(false);
        if (refreshAfterPending) { refreshAfterPending = false; schedule(); }
      }
    }
  };
  const schedule = () => {
    if (doc.visibilityState !== "visible") return;
    if (pending) { refreshAfterPending = true; return; }
    clearTimeout(timer);
    timer = setTimeout(() => { if (doc.visibilityState === "visible") void refresh(); }, Math.max(250, 1500 - (Date.now() - lastStarted)));
  };
  win.addEventListener("focus", schedule);
  doc.addEventListener("visibilitychange", schedule);
  void refresh();
  return { refresh, destroy() {
    controller.abort();
    clearTimeout(timer);
    win.removeEventListener("focus", schedule);
    doc.removeEventListener("visibilitychange", schedule);
  } };
}
