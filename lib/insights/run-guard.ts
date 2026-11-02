import type { AgAnyAiAgentRunner } from "ag-studio";
import { ANALYST_UNAVAILABLE } from "./gemini-adapter";

// A chart request runs ~8 model steps across the analyst, Page and Widget agents (~60-90 s on free Gemini);
// each call still aborts at 45 s, and busy turns may wait up to 35 s twice for a model to free up.
export const ANALYST_RUN_TIMEOUT_MS = 210_000;

/** Studio's delegate tool discards child RUN_ERRORs. Carry them to the owning chat run. */
export function recoveryRunGuard() {
  type Scope = { controller: AbortController; failure?: string; fail: (message: string) => void; stopped: Promise<void> };
  const runs = new Map<string, Scope>();
  return (runner: AgAnyAiAgentRunner): AgAnyAiAgentRunner => ({
    ...runner,
    async *run(input, context) {
      const parent = input.parentRunId ? runs.get(input.parentRunId) : undefined;
      let stop!: () => void;
      const scope: Scope = parent ?? {
        controller: new AbortController(), stopped: new Promise<void>((resolve) => { stop = resolve; }),
        fail(message) { this.failure ??= message; this.controller.abort(); stop(); },
      };
      runs.set(input.runId, scope);
      const signal = context.signal ? AbortSignal.any([context.signal, scope.controller.signal]) : scope.controller.signal;
      const timer = parent ? undefined : setTimeout(() => scope.fail(ANALYST_UNAVAILABLE), ANALYST_RUN_TIMEOUT_MS);
      const iterator = runner.run(input, { ...context, signal })[Symbol.asyncIterator]();
      let cancel!: () => void;
      const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
      context.signal?.addEventListener("abort", cancel, { once: true });
      if (context.signal?.aborted) cancel();
      try {
        while (true) {
          const next = await Promise.race([iterator.next(), scope.stopped.then(() => undefined), cancelled.then(() => undefined)]);
          if (scope.failure) {
            yield { type: "RUN_ERROR", message: scope.failure };
            return;
          }
          if (context.signal?.aborted) {
            yield { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId };
            return;
          }
          if (!next || next.done) return;
          if (next.value.type === "RUN_ERROR") {
            scope.fail(next.value.message);
            yield next.value;
            return;
          }
          yield next.value;
        }
      } catch {
        if (context.signal?.aborted && !scope.failure) {
          yield { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId };
        } else {
          scope.fail(ANALYST_UNAVAILABLE);
          yield { type: "RUN_ERROR", message: scope.failure! };
        }
      } finally {
        runs.delete(input.runId);
        if (timer !== undefined) clearTimeout(timer);
        context.signal?.removeEventListener("abort", cancel);
        // A tool may ignore abort. Do not let its cleanup hold the visible run open.
        void iterator.return?.().catch(() => {});
      }
    },
  });
}
