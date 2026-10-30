import { expect, it } from "vitest";
import { recoveryOutcomes, summarizeRecovery } from "../lib/recovery/outcomes";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import type { CustomerLink, StoredPlan } from "../lib/store";

it("counts an unanswered customer as settled once their private link has closed", () => {
  const state = seedStudio(), plan = { ...replan(state, demoDisruption), id: "p", workspaceId: "w", status: "executed", createdAt: "2026-10-31T10:00:00Z", results: [] } as StoredPlan;
  const moves = plan.bookingActions.filter((action) => action.action !== "refund");
  const link = (bookingId: string, expiresAt: number) => ({ id: bookingId, workspaceId: "w", planId: "p", bookingId, kind: "choice", expiresAt, createdAt: "2026-10-31T10:00:00Z" }) as unknown as CustomerLink;
  const open = summarizeRecovery(recoveryOutcomes(state, [plan], [], moves.map((action) => link(action.bookingId, Date.now() + 3_600_000))));
  const closed = summarizeRecovery(recoveryOutcomes(state, [plan], [], moves.map((action) => link(action.bookingId, Date.now() - 1))));
  expect(open.noReply).toBe(moves.length); expect(closed.noReply).toBe(0);
  expect(closed.kept + closed.moved).toBe(open.kept + open.moved);
});
