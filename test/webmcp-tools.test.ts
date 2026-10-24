import { describe, expect, it, vi } from "vitest";
import type { AgAiStudioTools, AgAiTool } from "ag-studio";
import { seedStudio } from "../lib/seed/seed";
import { bookingTools, localClass, ownerTools } from "../lib/webmcp/tools";
import { studioReadOnlyTools, studioTools } from "../lib/webmcp/studio";
import { createWebMcpBridge, type WebMcpTool } from "../lib/webmcp/bridge";

const context = { signal: new AbortController().signal };
describe("Rebook tool contracts", () => {
  it("reports studio-local times and active booking occupancy without customer/payment data", () => {
    const state = seedStudio();
    const tools = ownerTools({ state, plans: [], busy: false, report: vi.fn(), requestApproval: vi.fn() });
    const rows = tools.find((tool) => tool.name === "get_week_schedule")!.execute({}, context) as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ day: "2026-11-09", startTime: "07:00", timezone: "America/New_York", capacity: state.sessions[0].capacity });
    expect(rows[0].booked).toBe(state.bookings.filter((booking) => booking.sessionId === state.sessions[0].id && ["confirmed", "moved"].includes(booking.status)).length);
    expect(JSON.stringify(rows)).not.toMatch(/captureId|email|customerId/);
    expect(localClass("2026-11-10T01:00:00Z", "2026-11-10T02:00:00Z", state.studio.timezone)).toMatchObject({ day: "2026-11-09", startTime: "20:00", endTime: "21:00" });
  });

  it("filters classes by local day and type and prepares selection without invoking payment", () => {
    const select = vi.fn();
    const sessions = [{ id: "yoga-1", title: "Yoga", classType: "yoga", start: "2026-11-10T01:00:00Z", end: "2026-11-10T02:00:00Z", instructor: "Maya", room: "Main", seatsLeft: 1, price: "18.00", capacity: 10 }];
    const tools = bookingTools({ sessions, timezone: "America/New_York", locked: false, select });
    expect(tools[0].execute({ day: "monday", classType: "YOGA" }, context)).toMatchObject([{ sessionId: "yoga-1", day: "2026-11-09" }]);
    expect(tools[0].execute({ day: "2026-11-10" }, context)).toEqual([]);
    const start = tools.find((tool) => tool.name === "start_booking")!;
    expect(start.execute({ sessionId: "yoga-1", name: " Jamie ", email: "jamie@example.com" }, context)).toMatchObject({ status: "awaiting_human_payment" });
    expect(select).toHaveBeenCalledWith(sessions[0], { name: "Jamie", email: "jamie@example.com" });
    expect(start.description).toContain("human must approve");
    expect(() => start.execute({ sessionId: "yoga-1", email: "invalid" }, context)).toThrow("email");
    expect(() => start.execute({ sessionId: "missing" }, context)).toThrow("unavailable");
    expect(bookingTools({ sessions, timezone: "UTC", locked: true, select }).map((tool) => tool.name)).toEqual(["list_classes"]);
    expect(bookingTools({ sessions: [{ ...sessions[0], seatsLeft: 0 }], timezone: "UTC", locked: false, select }).map((tool) => tool.name)).toEqual(["list_classes"]);
  });

  it("reads live Studio schemas, withholds uncallable tools, and adapts object query arguments", async () => {
    let widgets = true;
    const execute = vi.fn(async () => ({ success: true as const, response: "Read only" }));
    const make = (name: string): AgAiTool => ({ name, description: name, kind: "client", execute,
      schema: () => name === "view_widget" && !widgets ? undefined : { name, description: name, parameters: name === "execute_query" ? { anyOf: [{ type: "object" }] } : { type: "object", properties: { id: { enum: [widgets ? "a" : "b"] } } } },
    });
    const toolkit = { viewSchema: () => make("view_schema"), viewPage: () => make("view_page"), viewWidget: () => make("view_widget"), executeQuery: () => make("execute_query"), deletePage: vi.fn() };
    const selected = studioReadOnlyTools(toolkit as unknown as AgAiStudioTools);
    const registered = new Map<string, WebMcpTool>();
    const registerTool = vi.fn((tool: WebMcpTool, { signal }: { signal: AbortSignal }) => { registered.set(tool.name, tool); signal.addEventListener("abort", () => registered.delete(tool.name)); });
    const bridge = createWebMcpBridge({ registerTool });
    await bridge.sync(studioTools(selected));
    expect([...registered.keys()]).toEqual(["view_schema", "view_page", "view_widget", "execute_query"]);
    expect([...registered.values()].every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    expect(registered.get("execute_query")?.inputSchema).toMatchObject({ type: "object", required: ["query"] });
    await registered.get("execute_query")!.execute({ query: { select: ["sessions.id"] } }, context);
    expect(execute.mock.calls[0]).toMatchObject([{ name: "execute_query", args: { select: ["sessions.id"] } }, { signal: context.signal }]);
    widgets = false;
    await bridge.sync(studioTools(selected));
    expect(registered.has("view_widget")).toBe(false);
    expect(registered.get("view_page")?.inputSchema.properties).toEqual({ id: { enum: ["b"] } });
    expect(toolkit.deletePage).not.toHaveBeenCalled();
    bridge.destroy();
  });
});
