import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import type { OutboxCustomer } from "../lib/choices/outbox";

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (value: unknown) => hooks.slots[hooks.cursor++] ??= { current: value },
  useState: (value: unknown) => {
    const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = value;
    return [hooks.slots[index], (next: unknown) => { hooks.slots[index] = next; }];
  },
  useEffect: () => {},
}));
import MessagesDrawer from "../components/console/messages-drawer";

type Element = ReactElement<Record<string, unknown>>;
let rows: OutboxCustomer[], tree: ReactNode, fetchMock: ReturnType<typeof vi.fn>, open: ReturnType<typeof vi.fn>, copy: ReturnType<typeof vi.fn>;
let onUpdated: ReturnType<typeof vi.fn<() => void>>;
const location = { origin: "https://studio.test", href: "", assign: (href: string) => { location.href = href; } };
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...elements(element.props.children as ReactNode)];
}
function render() {
  hooks.cursor = 0;
  tree = MessagesDrawer({ workspaceId: "workspace1", messages: [], outbox: rows, onUpdated, onClose: () => {} });
  return renderToStaticMarkup(tree);
}
function button(name: string) {
  const found = elements(tree).find((element) => element.type === "button" && (element.props["aria-label"] === name || element.props.children === name));
  if (!found) throw new Error(`Button missing: ${name}`); return found;
}
async function click(name: string) { (button(name).props.onClick as () => void)(); for (let index = 0; index < 20; index++) await Promise.resolve(); return render(); }
function row(name: string, sent = false, kind: "choice" | "receipt" = "choice"): OutboxCustomer {
  return { customerId: name, customerName: name, planId: "plan", changes: [{ bookingId: `booking-${name}`, kind,
    path: `/c/${name}`, subject: `New time for ${name}'s yoga & dance`, body: `Hi ${name},\n\nYour class moved & it's ready.`, sentAt: sent ? "2026-11-05T12:00:00Z" : undefined }] };
}
beforeEach(() => {
  hooks.cursor = 0; hooks.slots = []; rows = [row("Asha & Jo"), row("Bea", true), row("Chen", true, "receipt")];
  location.href = ""; open = vi.fn(); copy = vi.fn().mockResolvedValue(undefined); onUpdated = vi.fn();
  vi.stubGlobal("window", { location, open }); vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
  fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
    const input = JSON.parse(options.body as string);
    const updated = rows.map((customer) => customer.customerId === input.customerId ? { ...customer, changes: customer.changes.map((change) => ({ ...change, sentAt: input.sent ? "2026-11-05T13:00:00Z" : undefined })) } : customer);
    return Response.json({ outbox: updated });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

it("has list semantics, customer-specific actions, link kinds, sent times and polite status updates", () => {
  const html = render();
  expect(html).toContain('<ul class="outbox-list" aria-label="Customer outbox">');
  expect(elements(tree).filter((element) => element.type === "li")).toHaveLength(3);
  for (const name of ["WhatsApp Asha & Jo", "SMS Asha & Jo", "Email Asha & Jo", "Copy message for Asha & Jo", "Copy link for Asha & Jo, New time for Asha & Jo's yoga & dance"]) expect(button(name)).toBeTruthy();
  expect(button("Undo sent for Bea")).toBeTruthy();
  expect(html).toContain("Private choice link"); expect(html).toContain("Refund receipt");
  expect(html).toContain("Sent by owner"); expect(html).toContain('<time dateTime="2026-11-05T12:00:00Z">');
  expect(html).toContain("Not sent"); expect(html).toContain("No reply yet");
  expect(html).toContain('role="status" aria-live="polite"');
  expect(html).toContain("2 sent · 0 replied · 1 waiting");
});

it.each(["WhatsApp", "SMS", "Email", "Copy message for"])("%s shares the full message and link, saves Sent, then allows undo", async (channel) => {
  render(); const html = await click(`${channel} Asha & Jo`);
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe("/api/workspaces/workspace1/outbox"); expect(options.keepalive).toBe(true);
  expect(JSON.parse(options.body)).toEqual({ planId: "plan", customerId: "Asha & Jo", sent: true });
  expect(html).toContain("3 sent · 0 replied · 2 waiting"); expect(html).toContain("marked Sent by owner");
  expect(onUpdated).toHaveBeenCalledOnce();
  const body = channel === "WhatsApp" ? new URL(open.mock.calls[0][0]).searchParams.get("text")
    : channel === "Copy message for" ? copy.mock.calls[0][0] : new URL(location.href).searchParams.get("body");
  expect(body).toContain("Hi Asha & Jo,\n\nYour class moved & it's ready."); expect(body).toContain("https://studio.test/c/Asha%20&%20Jo");
  const undone = await click("Undo sent for Asha & Jo");
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).sent).toBe(false);
  expect(undone).toContain("2 sent · 0 replied · 1 waiting"); expect(undone).toContain("sent status undone");
});

it("copy link marks Sent, and failed copy or status persistence leaves the row unsent", async () => {
  render(); copy.mockRejectedValueOnce(new Error("denied"));
  expect(await click("Copy message for Asha & Jo")).toContain("Copy unavailable"); expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockResolvedValueOnce(Response.json({ error: "Save failed" }, { status: 503 }));
  expect(await click("WhatsApp Asha & Jo")).toContain("Sent status was not updated");
  expect(elements(tree).some((element) => element.props["aria-label"] === "Undo sent for Asha & Jo")).toBe(false);
  await click("Copy link for Asha & Jo, New time for Asha & Jo's yoga & dance");
  expect(copy.mock.calls.at(-1)?.[0]).toBe("https://studio.test/c/Asha%20&%20Jo"); expect(button("Undo sent for Asha & Jo")).toBeTruthy();
});

it("filters waiting rows and steps through short reminders without sending automatically", async () => {
  rows = [row("Asha", true), row("Bea", true), row("Chen", true, "receipt"), row("Dee")];
  render(); let html = await click("Waiting");
  expect(elements(tree).filter((element) => element.type === "li")).toHaveLength(2);
  expect(html).not.toContain('<h3>Chen</h3>'); expect(html).not.toContain('<h3>Dee</h3>');
  html = await click("Remind waiting");
  expect(html).toContain("Reminder 1 of 2: Asha"); expect(html).toContain("just a reminder"); expect(fetchMock).not.toHaveBeenCalled();
  await click("WhatsApp Asha");
  const body = new URL(open.mock.calls[0][0]).searchParams.get("text")!;
  expect(body).toContain("just a reminder"); expect(body).toContain("https://studio.test/c/Asha"); expect(body).not.toContain("Your class moved & it's ready");
  html = await click("Next customer"); expect(html).toContain("Reminder 2 of 2: Bea"); expect(button("Next customer").props.disabled).toBe(true);
  html = await click("Finish reminders"); expect(html).not.toContain("Reminder 2 of 2");
  html = await click("All customers"); expect(elements(tree).filter((element) => element.type === "li")).toHaveLength(4);
});

it("refreshes replies from owner polling, removes answered customers from Waiting, and avoids counting receipts as replies", async () => {
  render(); await click("Waiting");
  rows = rows.map((customer) => customer.customerId === "Bea" ? { ...customer, changes: customer.changes.map((change) => ({ ...change, reply: { status: "chose another class", at: "2026-11-05T13:00:00Z" } })) } : customer);
  let html = render(); expect(html).toContain("2 sent · 1 replied · 0 waiting"); expect(html).toContain("No customers waiting for a reply");
  html = await click("All customers"); expect(html).toContain("Replied: chose another class");
  expect(button("Remind waiting").props.disabled).toBe(true);
});

it("blocks repeated sharing while a write is pending and uses the latest polled reply after saving", async () => {
  let resolve!: (value: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
  render(); const share = button("WhatsApp Asha & Jo").props.onClick as () => void;
  share(); share(); render(); expect(fetchMock).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce(); expect(button("SMS Bea").props.disabled).toBe(true);
  resolve(Response.json({ outbox: rows.map((customer) => customer.customerId === "Asha & Jo" ? { ...customer, changes: customer.changes.map((change) => ({ ...change, sentAt: "2026-11-05T13:00:00Z" })) } : customer) }));
  for (let index = 0; index < 20; index++) await Promise.resolve(); render();
  rows = rows.map((customer) => customer.customerId === "Asha & Jo" ? { ...customer, changes: customer.changes.map((change) => ({ ...change, sentAt: "2026-11-05T13:00:00Z", reply: { status: "kept", at: "2026-11-05T13:01:00Z" } })) } : customer);
  expect(render()).toContain("3 sent · 1 replied · 1 waiting");
});
