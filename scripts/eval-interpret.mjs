import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Compare exact studio resource and local endpoints, including midnight on the following day. */
export function scoreCase(item, result, state) {
  if (item.expected.clarify) return { correct: result.kind === "clarify", dangerous: result.kind !== "clarify" };
  if (result.kind === "clarify") return { correct: false, dangerous: false };
  const { disruption } = result;
  const local = (instant) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: state.studio.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  };
  const expected = item.expected;
  const resource = expected.instructor ? disruption.kind === "instructor_unavailable" && state.instructors.find((person) => person.id === disruption.instructorId)?.name === expected.instructor
    : expected.room ? disruption.kind === "room_unavailable" && state.rooms.find((room) => room.id === disruption.roomId)?.name === expected.room : disruption.kind === "closure";
  return { correct: resource && local(disruption.from) === expected.window.from && local(disruption.to) === expected.window.to, dangerous: false };
}

export function evaluationReport(rows, total, elapsedMs, providers = []) {
  const categories = new Map();
  for (const row of rows) {
    const bucket = categories.get(row.category) ?? { total: 0, correct: 0, dangerous: 0, fallback: 0 };
    bucket.total++; bucket.correct += Number(row.correct); bucket.dangerous += Number(row.dangerous); bucket.fallback += Number(row.source === "rules");
    categories.set(row.category, bucket);
  }
  const percent = (count, denominator) => denominator ? `${(100 * count / denominator).toFixed(2)}%` : "n/a";
  const latencies = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  const middle = (values) => values.length ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2 : 0;
  const median = middle(latencies);
  const answered = rows.filter((row) => row.source && row.source !== "rules").map((row) => row.latencyMs).sort((a, b) => a - b);
  const bySource = ["gemini", "groq", "rules"].map((source) => `${source} ${rows.filter((row) => row.source === source).length}`).join(", ");
  return `# Live interpretation evaluation

Generated: ${new Date().toISOString()}. Evaluated ${rows.length}/${total} corpus items in ${(elapsedMs / 1000).toFixed(1)} s. Fixed studio clock: 2026-11-09 00:15 America/New_York; demo week: November 9–15, 2026.

Exact resource/window or clarification accuracy: ${percent(rows.filter((row) => row.correct).length, rows.length)}.
Dangerous false positives (must-clarify input produced a disruption): ${rows.filter((row) => row.dangerous).length}.
Rules result rate: ${percent(rows.filter((row) => row.source === "rules").length, rows.length)} (includes safety clarifications before a provider call).
Rules fallback rate after a provider attempt: ${percent(rows.filter((row) => row.fallbackReason).length, rows.length)} (model mismatch or provider unavailable).
Provider outage/timeout fallback rate: ${percent(rows.filter((row) => row.aiBusy).length, rows.length)}.
Median end-to-end interpretation latency: ${median.toFixed(1)} ms. Errors: ${rows.filter((row) => row.error).length}.
Median latency when a model answered (${answered.length} items): ${middle(answered).toFixed(1)} ms. Results by source: ${bySource}.${providers.length ? ` Providers configured for this run: ${providers.join(", ")}.` : ""}

| Category | Correct / evaluated | Accuracy | Dangerous false positives | Rules results |
| --- | --- | --- | --- | --- |
${[...categories].map(([name, bucket]) => `| ${name} | ${bucket.correct}/${bucket.total} | ${percent(bucket.correct, bucket.total)} | ${bucket.dangerous} | ${percent(bucket.fallback, bucket.total)} |`).join("\n")}

Full corpus size: ${total}; a bounded run is a subset, not a whole-corpus estimate. Items are selected round-robin across categories. One interpretation at a time; the production Gemini/Groq chain and its 12 s total deadline are used unchanged. No provider quotas or cooldowns are bypassed. Rules fallback can dominate a rate-limited run; inspect that rate before attributing accuracy to a model.

## Individual results

| ID | Category | Correct | Dangerous | Source | Model | Latency (ms) | Error |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows.map((row) => `| ${row.id} | ${row.category} | ${row.correct} | ${row.dangerous} | ${row.source ?? "error"} | ${row.model ?? "—"} | ${row.latencyMs.toFixed(1)} | ${row.error ? "Interpretation failed" : ""} |`).join("\n")}
`;
}

function argumentsFor(argv) {
  const config = { maxItems: 30, budgetMs: 120_000, delayMs: 500 };
  for (let index = 0; index < argv.length; index += 2) {
    const option = { "--max-items": "maxItems", "--budget-ms": "budgetMs", "--delay-ms": "delayMs" }[argv[index]];
    const value = Number(argv[index + 1]);
    if (!option || !Number.isSafeInteger(value) || value < 1) throw new Error("Use --max-items N --budget-ms N --delay-ms N (positive integers).");
    config[option] = value;
  }
  if (config.maxItems > 1000 || config.budgetMs > 3_600_000 || config.budgetMs < 12_000 || config.delayMs < 250 || config.delayMs > 60_000) throw new Error("Limits: max-items <= 1000, budget-ms 12000..3600000, delay-ms 250..60000.");
  return config;
}

// The existing TypeScript dev dependency lets this manual Node script load the exact production chain.
// No build, dev server, extra package or copied provider implementation is needed.
async function main() {
  if (process.argv.includes("--help")) {
    console.info("node --env-file=.env.local scripts/eval-interpret.mjs --max-items 177 --budget-ms 2400000 --delay-ms 1500\nDefaults: 30 items, 120000 ms total, 500 ms delay; concurrency is always 1. Writes docs/interpretation-eval.md.");
    return;
  }
  const config = argumentsFor(process.argv.slice(2));
  if (!process.env.GEMINI_API_KEY?.trim() && !process.env.GROQ_API_KEY?.trim()) throw new Error("Set GEMINI_API_KEY and/or GROQ_API_KEY for a live provider evaluation.");
  const require = createRequire(import.meta.url);
  const ts = require("typescript");
  require.extensions[".ts"] = (module, filename) => {
    const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
    module._compile(compiled.outputText, filename);
  };
  const { interpretDisruption } = require(resolve(root, "lib/ai/interpret.ts"));
  const { seedStudio } = require(resolve(root, "lib/seed/seed.ts"));
  const corpus = JSON.parse(readFileSync(resolve(root, "test/fixtures/interpret-eval.json"), "utf8"));
  const buckets = [...new Set(corpus.map((item) => item.category))].map((category) => corpus.filter((item) => item.category === category));
  const ordered = [];
  for (let index = 0; buckets.some((bucket) => index < bucket.length); index++) for (const bucket of buckets) if (bucket[index]) ordered.push(bucket[index]);
  const state = seedStudio(), started = performance.now(), rows = [];
  for (const item of ordered.slice(0, config.maxItems)) {
    // Reserve the full production deadline; no request may overrun this run's budget.
    if (performance.now() - started + 12_000 > config.budgetMs) break;
    const itemStarted = performance.now();
    try {
      const result = await interpretDisruption(item.input, state, "2026-11-09T05:15:00Z", state.studio.weekStart, { client: "manual-interpret-eval", workspace: "manual-interpret-eval" });
      rows.push({ id: item.id, category: item.category, ...scoreCase(item, result, state), source: result.source, model: result.model, aiBusy: Boolean(result.aiBusy), fallbackReason: result.fallbackReason, latencyMs: performance.now() - itemStarted });
    } catch {
      rows.push({ id: item.id, category: item.category, correct: false, dangerous: false, error: true, latencyMs: performance.now() - itemStarted });
    }
    console.info(`Evaluated ${rows.length}/${Math.min(config.maxItems, corpus.length)} (item ${item.id}).`);
    if (performance.now() - started + config.delayMs + 12_000 > config.budgetMs) break;
    await delay(config.delayMs);
  }
  writeFileSync(resolve(root, "docs/interpretation-eval.md"), evaluationReport(rows, corpus.length, performance.now() - started,
    ["GEMINI_API_KEY", "GROQ_API_KEY"].filter((key) => process.env[key]?.trim()).map((key) => key.split("_")[0].toLowerCase())));
  console.info(`Wrote docs/interpretation-eval.md (${rows.length}/${corpus.length} items).`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
