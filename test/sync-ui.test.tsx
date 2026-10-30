import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SyncPanel, { changeDescription } from "../components/console/sync-panel";
import type { SyncChange } from "../lib/sync/feed";

const session = { id: "dance", title: "Dance Flow", start: "2026-11-10T23:00:00Z", end: "2026-11-11T00:00:00Z", instructor: "Alex", room: "Studio" };
const customer = { id: "avery", name: "Avery", email: "avery@example.com" };
const change: SyncChange = { id: "pack:one", occurredAt: "2026-11-05T12:00:00Z", type: "pack.visit_returned", bookingId: "one", customer, visitsLeftAfter: 4 };
it("renders sync controls, endpoints, pending changes and recent events with the key hidden", () => {
  const key = "s".repeat(43);
  const html = renderToStaticMarkup(<SyncPanel workspaceId="abcdefghij" timezone="America/New_York" onRefresh={vi.fn()} sync={{ key, pending: 2, recentChanges: [change],
    recentEvents: [{ eventId: "event", type: "booking.created", receivedAt: change.occurredAt, result: { eventId: "event", status: "rejected", message: "Class is full" } }] }} />);
  for (const text of ['id="booking-sync"', "Booking system sync", "Show key", "2 pending outbound changes", "Mark all as applied", "Avery: 1 pack visit returned (4 left)",
    "sync/changes", "sync/ack", "sync/events", "Download pending CSV", "pack-balances?pending=1", "booking.created", "rejected", "Class is full", "Sync API documentation", 'role="status"', 'aria-expanded="false"']) expect(html).toContain(text);
  expect(html).not.toContain(key); expect(html).not.toContain("Copy key");
});
it("describes each outbound type in plain words and studio local time", () => {
  const base = { id: "change", occurredAt: change.occurredAt };
  const changes: SyncChange[] = [
    { ...base, type: "session.moved", session, before: session, after: session },
    { ...base, type: "session.cancelled", session },
    { ...base, type: "booking.moved", bookingId: "one", customer, from: session, to: session },
    { ...base, type: "booking.cancelled", bookingId: "one", customer, session, reason: "refunded", amount: "22.00" },
    { ...base, type: "booking.created", bookingId: "one", customer, session, source: "checkout", amount: "22.00" }, change,
  ];
  const descriptions = changes.map((row) => changeDescription(row, "America/New_York"));
  expect(descriptions[0]).toContain("Dance Flow moved to Tue 6:00 PM");
  expect(descriptions[1]).toBe("Dance Flow cancelled");
  expect(descriptions[2]).toContain("Avery moved to Dance Flow");
  expect(descriptions[3]).toContain("refunded ($22.00)");
  expect(descriptions[4]).toContain("Avery booked Dance Flow (checkout)");
  expect(descriptions[5]).toBe("Avery: 1 pack visit returned (4 left)");
});
it("renders an empty panel without disabled or hidden data leaking into markup", () => {
  const html = renderToStaticMarkup(<SyncPanel workspaceId="abcdefghij" timezone="UTC" onRefresh={vi.fn()} />);
  expect(html).toContain("0 pending outbound changes"); expect(html).toContain("No inbound events yet.");
  expect(html).toContain('disabled=""');
});
