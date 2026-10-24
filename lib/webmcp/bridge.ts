export type ToolInput = Record<string, unknown>;
export type ToolSchema = { type: "object"; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
export type WebMcpTool = {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  annotations?: { readOnlyHint?: boolean; consequentialHint?: boolean; untrustedContentHint?: boolean };
  execute(input: ToolInput, context: { signal: AbortSignal }): unknown | Promise<unknown>;
};
export type ModelContext = {
  registerTool(tool: WebMcpTool, options: { signal: AbortSignal }): void | Promise<void>;
};

/** Current Chrome uses document; older experimental builds used navigator. */
export function detectModelContext(): ModelContext | undefined {
  if (typeof window === "undefined" || !window.isSecureContext) return;
  const current = (document as Document & { modelContext?: ModelContext }).modelContext;
  const legacy = (navigator as Navigator & { modelContext?: ModelContext }).modelContext;
  return [current, legacy].find((context) => typeof context?.registerTool === "function");
}

const advertised = new Map<object, string[]>();
const listeners = new Set<() => void>();
export const subscribeTools = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const toolSnapshot = () => [...new Set([...advertised.values()].flat())].sort().join(", ");
const changed = () => listeners.forEach((listener) => listener());

/** One owner per mounted page/widget. Updates handlers without re-registering unchanged schemas. */
export function createWebMcpBridge(context = detectModelContext()) {
  const registrations = new Map<string, { controller: AbortController; signature: string }>();
  let desired = new Map<string, WebMcpTool>();
  let destroyed = false;
  let pending = Promise.resolve();
  let error: string | undefined;
  const owner = {};
  const publish = () => { advertised.set(owner, [...registrations.keys()]); changed(); };
  function remove(name: string) {
    registrations.get(name)?.controller.abort();
    registrations.delete(name);
  }
  async function reconcile() {
    if (!context || destroyed) return;
    error = undefined;
    for (const name of registrations.keys()) if (!desired.has(name)) remove(name);
    for (const [name, tool] of desired) {
      if (destroyed) break;
      const signature = JSON.stringify([tool.description, tool.inputSchema, tool.annotations]);
      if (registrations.get(name)?.signature === signature) continue;
      remove(name);
      const controller = new AbortController();
      registrations.set(name, { controller, signature });
      try {
        await context.registerTool({ ...tool, execute: async (input, execution) => {
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool arguments must be an object.");
          const live = desired.get(name);
          if (destroyed || controller.signal.aborted || !live) throw new Error("This tool is no longer available.");
          const signal = execution?.signal ?? controller.signal;
          signal.throwIfAborted();
          const result = await live.execute(input, { signal });
          return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result ?? null) }] };
        } }, { signal: controller.signal });
      } catch (cause) {
        remove(name);
        error = cause instanceof Error ? cause.message : String(cause);
      }
      if (destroyed) { remove(name); break; }
    }
    if (!destroyed) publish();
  }
  return {
    supported: Boolean(context),
    sync(tools: readonly WebMcpTool[]) {
      if (destroyed) return pending;
      desired = new Map(tools.map((tool) => [tool.name, tool]));
      // Browser registration is asynchronous: serialize schema replacements and unregistration.
      pending = pending.then(reconcile).catch((cause) => { error = String(cause); });
      return pending;
    },
    lastError: () => error,
    destroy() {
      destroyed = true;
      desired.clear();
      for (const name of registrations.keys()) remove(name);
      advertised.delete(owner); changed();
    },
  };
}
