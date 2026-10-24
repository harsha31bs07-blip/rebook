import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebMcpBridge, detectModelContext, toolSnapshot, type ModelContext, type WebMcpTool } from "../lib/webmcp/bridge";
import { useWebMcp } from "../lib/webmcp/use-webmcp";

const lifecycle = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[] }));
vi.mock("react", () => ({ useRef: () => ({ current: undefined }), useEffect: (effect: () => void | (() => void)) => { lifecycle.effects.push(effect); } }));

function fakeContext() {
  const tools = new Map<string, WebMcpTool>();
  const registerTool = vi.fn((tool: WebMcpTool, { signal }: { signal: AbortSignal }) => {
    tools.set(tool.name, tool);
    signal.addEventListener("abort", () => tools.delete(tool.name), { once: true });
  });
  return { tools, registerTool };
}
const descriptor = (value: number, inputSchema: WebMcpTool["inputSchema"] = { type: "object" }): WebMcpTool => ({
  name: "read", description: "Read live state", inputSchema, execute: () => ({ value }),
});
const execution = () => ({ signal: new AbortController().signal });
afterEach(() => vi.unstubAllGlobals());

describe("WebMCP lifecycle bridge", () => {
  it("feature-detects the current and legacy spelling only in a secure context", () => {
    const current = fakeContext(), legacy = fakeContext();
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("document", { modelContext: current });
    vi.stubGlobal("navigator", { modelContext: legacy });
    expect(detectModelContext()).toBe(current);
    vi.stubGlobal("document", {});
    expect(detectModelContext()).toBe(legacy);
    vi.stubGlobal("window", { isSecureContext: false });
    expect(detectModelContext()).toBeUndefined();
  });

  it("is harmless when unsupported or server-rendered", async () => {
    expect(detectModelContext()).toBeUndefined();
    const bridge = createWebMcpBridge();
    expect(bridge.supported).toBe(false);
    await expect(bridge.sync([descriptor(1)])).resolves.toBeUndefined();
    bridge.destroy();
  });

  it("registers with AbortSignal, reads fresh state without churn, and unregisters on destroy", async () => {
    const context = fakeContext();
    const bridge = createWebMcpBridge(context);
    await bridge.sync([descriptor(1)]);
    const read = context.tools.get("read")!;
    expect(await read.execute({}, execution())).toEqual({ content: [{ type: "text", text: '{"value":1}' }] });
    await bridge.sync([descriptor(2)]);
    expect(context.registerTool).toHaveBeenCalledTimes(1);
    expect(await read.execute({}, execution())).toEqual({ content: [{ type: "text", text: '{"value":2}' }] });
    expect(toolSnapshot()).toContain("read");
    bridge.destroy();
    expect(context.tools.size).toBe(0);
    expect(context.registerTool.mock.calls[0][1].signal.aborted).toBe(true);
    expect(toolSnapshot()).not.toContain("read");
    await expect(read.execute({}, execution())).rejects.toThrow("no longer available");
  });

  it("replaces changed schemas and removes tools that become unavailable", async () => {
    const context = fakeContext();
    const bridge = createWebMcpBridge(context);
    await bridge.sync([descriptor(1)]);
    await bridge.sync([descriptor(2, { type: "object", properties: { id: { enum: ["new-id"] } } })]);
    expect(context.registerTool).toHaveBeenCalledTimes(2);
    expect(context.registerTool.mock.calls[0][1].signal.aborted).toBe(true);
    expect(context.tools.get("read")?.inputSchema.properties?.id).toEqual({ enum: ["new-id"] });
    await bridge.sync([]);
    expect(context.tools.size).toBe(0);
    bridge.destroy();
  });

  it("retries failed registrations without throwing into the page", async () => {
    const context = fakeContext();
    context.registerTool.mockImplementationOnce(() => { throw new Error("Browser rejected registration"); });
    const bridge = createWebMcpBridge(context);
    await bridge.sync([descriptor(1)]);
    expect(bridge.lastError()).toContain("rejected");
    expect(toolSnapshot()).not.toContain("read");
    await bridge.sync([descriptor(1)]);
    expect(context.tools.has("read")).toBe(true);
    expect(bridge.lastError()).toBeUndefined();
    bridge.destroy();
  });

  it("serializes registrations and aborts pending work on unmount", async () => {
    let complete!: () => void;
    const registered = vi.fn<ModelContext["registerTool"]>(() => new Promise<void>((resolve) => { complete = resolve; }));
    const bridge = createWebMcpBridge({ registerTool: registered } satisfies ModelContext);
    const first = bridge.sync([descriptor(1)]);
    await Promise.resolve();
    const second = bridge.sync([descriptor(2, { type: "object", properties: { next: {} } })]);
    expect(registered).toHaveBeenCalledTimes(1);
    bridge.destroy();
    expect(registered.mock.calls[0][1].signal.aborted).toBe(true);
    complete();
    await Promise.all([first, second]);
    expect(registered).toHaveBeenCalledTimes(1);
    expect(toolSnapshot()).not.toContain("read");
  });

  it("accepts object arguments, rejects deprecated JSON strings, and forwards cancellation", async () => {
    const context = fakeContext();
    const bridge = createWebMcpBridge(context);
    const execute = vi.fn(() => "done");
    await bridge.sync([{ ...descriptor(1), execute }]);
    const tool = context.tools.get("read")!;
    const controller = new AbortController();
    await tool.execute({ value: 3 }, { signal: controller.signal });
    expect(execute).toHaveBeenCalledWith({ value: 3 }, { signal: controller.signal });
    await expect(tool.execute("{}" as unknown as Record<string, unknown>, execution())).rejects.toThrow("object");
    controller.abort();
    await expect(tool.execute({}, { signal: controller.signal })).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
    bridge.destroy();
  });

  it("ties registration and AbortSignal cleanup to the page hook's mount/unmount", async () => {
    const context = fakeContext();
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("document", { modelContext: context });
    vi.stubGlobal("navigator", {});
    lifecycle.effects = [];
    const getTools = vi.fn(() => [descriptor(1)]);
    useWebMcp(getTools);
    expect(getTools).not.toHaveBeenCalled();
    const unmount = lifecycle.effects[0]();
    lifecycle.effects[1]();
    expect(getTools).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 4; index++) await Promise.resolve();
    expect(context.tools.has("read")).toBe(true);
    if (unmount) unmount();
    expect(context.tools.size).toBe(0);
    expect(context.registerTool.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
