// Run: npx vitest run scripts/benchmark-replan.test.ts --pool=threads --maxWorkers=1 --reporter=verbose --disableConsoleIntercept
// Optional: REPLAN_BASELINE=capture|compare saves/checks complete plans in the OS temp directory.
// REPLAN_PROFILE=1 writes rebook-t3b.cpuprofile there for CPU profiling.
import { expect, it } from "vitest";
import { Session } from "node:inspector/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedStudio, demoDisruption, floodDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import type { Disruption } from "../lib/domain/types";

it("benchmarks six plans per scenario", async () => {
  const profiler = process.env.REPLAN_PROFILE ? new Session() : undefined;
  if (profiler) {
    profiler.connect();
    await profiler.post("Profiler.enable");
    await profiler.post("Profiler.start");
  }
  const scenarios: Record<string, Disruption> = {
    hero: demoDisruption,
    flood: floodDisruption,
    closure: { kind: "closure", from: "2026-11-14T05:00:00.000Z", to: "2026-11-15T05:00:00.000Z" },
  };
  for (const [name, disruption] of Object.entries(scenarios)) {
    const state = seedStudio();
    const timings: number[] = [];
    for (let run = 0; run < 6; run++) {
      const start = performance.now();
      const plan = replan(state, disruption);
      timings.push(performance.now() - start);
      const baseline = join(tmpdir(), `rebook-t3b-${name}.json`);
      if (process.env.REPLAN_BASELINE === "capture") writeFileSync(baseline, JSON.stringify(plan));
      if (process.env.REPLAN_BASELINE === "compare") expect(plan).toEqual(JSON.parse(readFileSync(baseline, "utf8")));
    }
    const sorted = [...timings].sort((a, b) => a - b);
    console.info(name, JSON.stringify({ runs: timings.map((ms) => +ms.toFixed(2)), median: +((sorted[2] + sorted[3]) / 2).toFixed(2) }));
  }
  if (profiler) {
    const { profile } = await profiler.post("Profiler.stop");
    writeFileSync(join(tmpdir(), "rebook-t3b.cpuprofile"), JSON.stringify(profile));
    profiler.disconnect();
  }
});
