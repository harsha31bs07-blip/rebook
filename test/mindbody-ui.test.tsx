import { readFileSync } from "node:fs";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], push: vi.fn(), refresh: vi.fn() }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useRef: (value: unknown) => harness.slots[harness.cursor++] ??= { current: value },
  useState: (value: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = value;
    return [harness.slots[index], (next: unknown) => { harness.slots[index] = next; }];
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: harness.push }) }));
vi.mock("@/lib/import/fields", () => import("../lib/import/fields"));
import ImportPage from "../components/import/import-page";
import SyncPanel from "../components/console/sync-panel";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...elements(element.props.children as ReactNode)];
}
const click = async (tree: ReactNode, text: string) => {
  const button = elements(tree).find((row) => row.type === "button" && row.props.children === text)!;
  await (button.props.onClick as () => Promise<void>)();
};
const renderImport = (enabled = true) => { harness.cursor = 0; return ImportPage({ enabled }); };
const renderSync = () => { harness.cursor = 0; return SyncPanel({ workspaceId: "abcdefghij", timezone: "America/Los_Angeles", mindbody: { connected: true, location: "Harbor", week: "2026-11-02" }, onRefresh: harness.refresh }); };
beforeEach(() => { harness.slots = []; harness.cursor = 0; vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());
it("shows the import option only when the server enables it and keeps the key out of markup", () => {
  expect(renderToStaticMarkup(renderImport(false))).not.toContain("Import from Mindbody");
  const html = renderToStaticMarkup(renderImport());
  expect(html).toContain("Import from Mindbody (sandbox)"); expect(html).toContain("Reads one week from Mindbody&#x27;s public sandbox studio.");
  expect(html).not.toContain("MINDBODY_API_KEY");
});
it("shows the summary and warnings before opening the imported workspace", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "abcdefghij", summary: { classes: 8, instructors: 3, rooms: 2, customers: 10, bookings: 12, weekOf: "2026-11-02" }, warnings: ["Payments are simulated"] }));
  vi.stubGlobal("fetch", fetcher);
  await click(renderImport(), "Import from Mindbody (sandbox)"); await vi.waitFor(() => expect(harness.slots.at(-1)).toHaveProperty("id", "abcdefghij"));
  const tree = renderImport(), html = renderToStaticMarkup(tree);
  expect(html).toContain("What Rebook assumed"); expect(html).toContain("Payments are simulated"); expect(html).toContain("<strong>12</strong> bookings");
  await click(tree, "Open the Mindbody workspace"); expect(harness.push).toHaveBeenCalledWith("/w/abcdefghij");
});
it("keeps the generic API controls and announces push failures and received booking counts", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ applied: 12, failed: [{ id: "one", message: "Class unavailable" }], pending: 1 }))
    .mockResolvedValueOnce(Response.json({ results: [], summary: { bookings: 2, cancellations: 1, other: 0 } }));
  vi.stubGlobal("fetch", fetcher);
  let tree = renderSync(); const html = renderToStaticMarkup(tree);
  for (const text of ["Connected to Mindbody sandbox", "Harbor", "Send changes to Mindbody", "Check Mindbody for changes", "sync/events", 'role="status"']) expect(html).toContain(text);
  await click(tree, "Send changes to Mindbody"); await vi.waitFor(() => expect(harness.refresh).toHaveBeenCalledTimes(1));
  expect(renderToStaticMarkup(renderSync())).toContain("12 changes applied in Mindbody · 1 failed: Class unavailable");
  tree = renderSync(); await click(tree, "Check Mindbody for changes"); await vi.waitFor(() => expect(harness.refresh).toHaveBeenCalledTimes(2));
  expect(renderToStaticMarkup(renderSync())).toContain("2 bookings and 1 cancellation received");
});
it("uses wrapping controls and existing mobile spacing without fixed widths", () => {
  const css = readFileSync("app/globals.css", "utf8");
  expect(css).toMatch(/\.import-fields\s*\{[^}]*flex-wrap:\s*wrap/);
  expect(renderToStaticMarkup(renderSync())).toContain("min-width:0;overflow-wrap:anywhere");
});
