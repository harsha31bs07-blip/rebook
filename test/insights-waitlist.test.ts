import { expect, it } from "vitest";
import { buildInsights } from "../lib/insights/data";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import type { StoredPlan, WaitlistOffer } from "../lib/store";

it("credits seats refilled from the waitlist to the recovery applied before the offer", () => {
  const state = seedStudio(), plan = replan(state, demoDisruption);
  const stored = (id: string, createdAt: string) => ({ ...plan, id, workspaceId: "w", status: "executed", createdAt, results: [], version: 1 }) as StoredPlan;
  const first = stored("first", "2026-10-31T10:00:00Z"), second = stored("second", "2026-10-31T15:00:00Z");
  const [a, b, c] = state.bookings;
  const offer = (bookingId: string, createdAt: string, status: WaitlistOffer["status"] = "claimed") => ({ id: bookingId, workspaceId: "w", entryId: "e", sessionId: "s", customerId: "c", status, expiresAt: createdAt, createdAt, bookingId }) as WaitlistOffer;
  const insights = buildInsights(state, [first, second], [], [], [], [], [offer(a.id, "2026-10-31T11:00:00Z"), offer(b.id, "2026-10-31T16:00:00Z"), offer(c.id, "2026-10-31T12:00:00Z", "declined"), offer(c.id, "2026-10-31T09:00:00Z")]);
  const row = (id: string) => insights.disruptions.find((item) => item.id === id)!;
  expect(row("first").waitlist_won_back).toBe(Number(a.amount)); expect(row("second").waitlist_won_back).toBe(Number(b.amount));
});
