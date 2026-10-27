import { expect, it } from "vitest";
import { evaluationReport, scoreCase } from "../scripts/eval-interpret.mjs";
import { demoDisruption, seedStudio } from "../lib/seed/seed";

it("scores exact local windows, wrong resources, missed clarifications and dangerous outputs", () => {
  const state = seedStudio();
  const positive = { expected: { instructor: "Maya Chen", window: { from: "2026-11-09T00:00", to: "2026-11-10T00:00" } } };
  expect(scoreCase(positive, { disruption: demoDisruption }, state)).toEqual({ correct: true, dangerous: false });
  expect(scoreCase(positive, { disruption: { ...demoDisruption, instructorId: "instructor-02" } }, state).correct).toBe(false);
  expect(scoreCase(positive, { disruption: { ...demoDisruption, to: "2026-11-10T06:00:00Z" } }, state).correct).toBe(false);
  expect(scoreCase(positive, { kind: "clarify" }, state)).toEqual({ correct: false, dangerous: false });
  expect(scoreCase({ expected: { clarify: true } }, { disruption: demoDisruption }, state)).toEqual({ correct: false, dangerous: true });
  expect(scoreCase({ expected: { clarify: true } }, { kind: "clarify" }, state)).toEqual({ correct: true, dangerous: false });
});

it("reports category accuracy, dangerous results, rules/outage rates, coverage, errors and median latency", () => {
  const report = evaluationReport([
    { id: 1, category: "plain", correct: true, dangerous: false, source: "groq", latencyMs: 100 },
    { id: 2, category: "plain", correct: false, dangerous: false, source: "rules", aiBusy: true, fallbackReason: "provider_unavailable", latencyMs: 300 },
    { id: 3, category: "negation", correct: false, dangerous: true, source: "gemini", latencyMs: 200 },
    { id: 4, category: "unknown", correct: false, dangerous: false, error: true, latencyMs: 400 },
  ], 168, 5000);
  expect(report).toContain("Evaluated 4/168");
  expect(report).toContain("accuracy: 25.00%");
  expect(report).toContain("produced a disruption): 1");
  expect(report).toContain("Rules result rate: 25.00%");
  expect(report).toContain("Rules fallback rate after a provider attempt: 25.00%");
  expect(report).toContain("fallback rate: 25.00%");
  expect(report).toContain("latency: 250.0 ms");
  expect(report).toContain("Errors: 1");
  expect(report).toContain("| plain | 1/2 | 50.00% | 0 | 50.00% |");
  expect(report).toContain("a subset, not a whole-corpus estimate");
});
