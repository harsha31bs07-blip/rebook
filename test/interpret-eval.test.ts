import { describe, expect, it } from "vitest";
import corpus from "./fixtures/interpret-eval.json";
import { interpretRules } from "../lib/ai/interpret";
import { localParts } from "../lib/domain/time";
import { seedStudio } from "../lib/seed/seed";

const state = seedStudio();
const now = "2026-11-09T05:15:00Z";
const local = (instant: string) => {
  const parts = localParts(instant, state.studio.timezone);
  return `${parts.dateKey}T${String(Math.floor(parts.minutesOfDay / 60)).padStart(2, "0")}:${String(parts.minutesOfDay % 60).padStart(2, "0")}`;
};

describe("deterministic interpretation evaluation (no network)", () => {
  it("has no dangerous false positives and at least 95% exact resource/window accuracy", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(120);
    const dangerous: string[] = [], failures: string[] = [];
    const categories = new Map<string, { correct: number; total: number }>();
    for (const item of corpus) {
      const result = interpretRules(item.input, state, now);
      const expected = item.expected;
      let correct: boolean;
      if (expected.clarify) {
        correct = result.kind === "clarify";
        if (!correct) dangerous.push(item.input);
      } else if (result.kind === "clarify") correct = false;
      else {
        const disruption = result.disruption;
        correct = (expected.instructor ? disruption.kind === "instructor_unavailable" && state.instructors.find((person) => person.id === disruption.instructorId)?.name === expected.instructor
          : expected.room ? disruption.kind === "room_unavailable" && state.rooms.find((room) => room.id === disruption.roomId)?.name === expected.room
            : disruption.kind === "closure") && local(disruption.from) === expected.window?.from && local(disruption.to) === expected.window?.to;
      }
      if (!correct) failures.push(`${item.id}: ${item.input} => ${JSON.stringify(result)}`);
      const category = categories.get(item.category) ?? { correct: 0, total: 0 };
      category.total++; category.correct += Number(correct); categories.set(item.category, category);
    }
    const accuracy = (corpus.length - failures.length) / corpus.length;
    console.info(`Rules: ${corpus.length - failures.length}/${corpus.length} (${(100 * accuracy).toFixed(2)}%); dangerous false positives: ${dangerous.length}. Categories: ${JSON.stringify(Object.fromEntries(categories))}. Misses: ${failures.join("\n")}`);
    expect(dangerous, "Must-clarify inputs must never create a disruption").toEqual([]);
    expect(accuracy, failures.join("\n")).toBeGreaterThanOrEqual(0.95);
  });
});
