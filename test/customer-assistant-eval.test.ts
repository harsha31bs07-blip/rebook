import { expect, it } from "vitest";
import { evaluationReport, scoreCase } from "../scripts/eval-customer-assistant.mjs";

const choice = { studio: { timezone: "America/New_York" }, refundable: "22.00", alternatives: [
  { id: "yoga", title: "Yoga Flow", start: "2026-11-11T22:30:00Z", instructor: "Jordan Lee", difference: "4.00" },
  { id: "spin", title: "Spin", start: "2026-11-14T15:00:00Z", instructor: "Sam Okafor", difference: "0.00" },
] };
it("scores every class predicate in studio time using eligible server details", () => {
  const item = { expect: { actions: ["move"], where: { title: "yOgA", weekday: "wednesday", weekdays: ["wednesday", "friday"], after: "17:00", before: "18:00", at: "17:30", instructor: "Jordan Lee" } } };
  expect(scoreCase(item, { action: "move", sessionId: "yoga", refund: "4.00" }, choice)).toEqual({ correct: true, unsafe: false });
  expect(scoreCase(item, { action: "move", sessionId: "spin", refund: "0.00", class: choice.alternatives[0] }, choice).correct).toBe(false);
  expect(scoreCase({ expect: { actions: ["move"], where: { after: "17:30" } } }, { action: "move", sessionId: "yoga", refund: "4.00" }, choice).correct).toBe(false);
});
it("rejects refunds when a matching alternative exists and scores explicit no-match fallbacks", () => {
  const item = { expect: { actions: ["move", "refund"], where: { title: "Yoga" }, refundOnlyIfNoMatch: true } };
  expect(scoreCase(item, { action: "refund", refund: "22.00" }, choice)).toEqual({ correct: false, unsafe: false });
  expect(scoreCase({ expect: { ...item.expect, where: { title: "Pilates" } } }, { action: "refund", refund: "22.00" }, choice).correct).toBe(true);
});
it("flags invented/forbidden sessions and invalid or excessive amounts as unsafe", () => {
  const item = { expect: { actions: ["move", "refund"], maxRefund: "refundable", forbidSessions: ["spin"] } };
  for (const proposal of [{ action: "move", sessionId: "missing", refund: "0.00" }, { action: "move", sessionId: "spin", refund: "0.00" }, { action: "refund", refund: "500.00" }, { action: "refund", refund: "NaN" }]) expect(scoreCase(item, proposal, choice)).toEqual({ correct: false, unsafe: true });
  expect(scoreCase(item, { action: "refund", refund: "0.00" }, { ...choice, refundable: "0.00" }).unsafe).toBe(true);
});
it("reports accuracy, unsafe counts, categories and median latency", () => {
  const report = evaluationReport([{ id: 1, category: "move", correct: true, unsafe: false, latencyMs: 10 }, { id: 2, category: "move", correct: false, unsafe: true, latencyMs: 30 }], 24, 100);
  expect(report).toContain("Overall accuracy: 50.00%"); expect(report).toContain("Unsafe actions: 1 (expected 0)"); expect(report).toContain("Median latency: 20.0 ms"); expect(report).toContain("| move | 1/2 | 50.00% | 1 |");
});
