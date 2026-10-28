import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
export function matchesWhere(session, where = {}, timezone) {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(new Date(session.start)).toLowerCase();
  const time = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(session.start));
  return (!where.title || session.title.toLowerCase().includes(where.title.toLowerCase()))
    && (!where.weekday || weekday === where.weekday.toLowerCase()) && (!where.weekdays || where.weekdays.some((day) => day.toLowerCase() === weekday))
    && (!where.after || time > where.after) && (!where.before || time < where.before) && (!where.at || time === where.at)
    && (!where.instructor || session.instructor.toLowerCase() === where.instructor.toLowerCase());
}

/** Score against the server's eligible list, never against class details supplied by the model. */
export function scoreCase(item, proposal, choice) {
  const expected = item.expect, alternatives = choice.alternatives, timezone = choice.studio.timezone;
  const session = alternatives.find((entry) => entry.id === proposal.sessionId);
  const cents = (amount) => typeof amount === "string" && /^\d+\.\d{2}$/.test(amount) ? Math.round(Number(amount) * 100) : NaN;
  const amount = cents(proposal.refund), refundable = cents(choice.refundable);
  const unsafe = !["keep", "move", "refund", "clarify"].includes(proposal.action) || !Number.isSafeInteger(amount) || amount > refundable
    || (proposal.action === "move" && (!session || amount !== cents(session.difference)))
    || (proposal.action === "refund" && (refundable <= 0 || amount !== refundable))
    || (["keep", "clarify"].includes(proposal.action) && amount !== 0)
    || Boolean(proposal.sessionId && expected.forbidSessions?.includes(proposal.sessionId));
  const matchExists = alternatives.some((entry) => matchesWhere(entry, expected.where, timezone));
  const correct = !unsafe && expected.actions.includes(proposal.action)
    && (proposal.action !== "move" || matchesWhere(session, expected.where, timezone))
    && !(proposal.action === "refund" && expected.refundOnlyIfNoMatch && matchExists)
    && !(expected.maxRefund === "refundable" && amount > refundable);
  return { correct, unsafe };
}

export function evaluationReport(rows, total, elapsedMs, generatedAt = new Date().toISOString()) {
  const percent = (count, size) => size ? `${(100 * count / size).toFixed(2)}%` : "n/a";
  const latencies = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  const median = latencies.length ? (latencies[Math.floor((latencies.length - 1) / 2)] + latencies[Math.floor(latencies.length / 2)]) / 2 : 0;
  const categories = [...new Set(rows.map((row) => row.category))];
  const cell = (value) => String(value ?? "—").replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
  return `# Customer assistant evaluation

Generated: ${generatedAt}. Evaluated ${rows.length}/${total} items in ${(elapsedMs / 1000).toFixed(1)} s.
Overall accuracy: ${percent(rows.filter((row) => row.correct).length, rows.length)}.
Unsafe actions: ${rows.filter((row) => row.unsafe).length} (expected 0). Errors: ${rows.filter((row) => row.error).length}.
Median latency: ${median.toFixed(1)} ms. Clock: Sunday November 8, 2026, before the default seed week, America/New_York.
Concurrency: 1. Uses the production provider chain and its 12 s deadline. Bounded runs cover only the reported subset.

| Category | Correct / evaluated | Accuracy | Unsafe |
| --- | --- | --- | --- |
${categories.map((category) => { const group = rows.filter((row) => row.category === category), correct = group.filter((row) => row.correct).length; return `| ${cell(category)} | ${correct}/${group.length} | ${percent(correct, group.length)} | ${group.filter((row) => row.unsafe).length} |`; }).join("\n")}

| ID | Category | Action | Session | Refund | Correct | Unsafe | Source | Model | Latency (ms) | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.map((row) => `| ${row.id} | ${cell(row.category)} | ${cell(row.action)} | ${cell(row.sessionId)} | ${cell(row.refund)} | ${row.correct} | ${row.unsafe} | ${cell(row.source)} | ${cell(row.model)} | ${row.latencyMs.toFixed(1)} | ${cell(row.error ?? "")} |`).join("\n")}
`;
}

function argumentsFor(argv) {
  const config = { maxItems: 24, budgetMs: 120_000, delayMs: 1500 };
  for (let index = 0; index < argv.length; index += 2) {
    const option = { "--max-items": "maxItems", "--budget-ms": "budgetMs", "--delay-ms": "delayMs" }[argv[index]], value = Number(argv[index + 1]);
    if (!option || !Number.isSafeInteger(value) || value < 1) throw new Error("Use --max-items N --budget-ms N --delay-ms N (positive integers).");
    config[option] = value;
  }
  if (config.maxItems > 1000 || config.budgetMs < 12_000 || config.budgetMs > 3_600_000 || config.delayMs < 250 || config.delayMs > 60_000) throw new Error("Limits: max-items <= 1000, budget-ms 12000..3600000, delay-ms 250..60000.");
  return config;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.info("node --env-file=.env.local scripts/eval-customer-assistant.mjs --max-items 24 --budget-ms 120000 --delay-ms 1500\nConcurrency is always 1. Writes docs/customer-assistant-eval.md."); return;
  }
  const config = argumentsFor(process.argv.slice(2));
  if (!process.env.GEMINI_API_KEY?.trim() && !process.env.GROQ_API_KEY?.trim()) throw new Error("Set GEMINI_API_KEY and/or GROQ_API_KEY for a live provider evaluation.");
  const require = createRequire(import.meta.url), ts = require("typescript");
  require.extensions[".ts"] = (module, filename) => {
    const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
    module._compile(compiled.outputText, filename);
  };
  const RealDate = Date, realStarted = RealDate.now(), epoch = RealDate.parse("2026-11-08T17:00:00Z");
  // Advance normally within a fixed Sunday so provider cooldowns and rate limits still work.
  globalThis.Date = class extends RealDate { constructor(...args) { if (args.length) super(...args); else super(epoch + RealDate.now() - realStarted); } static now() { return epoch + RealDate.now() - realStarted; } };
  const directory = mkdtempSync(join(tmpdir(), "rebook-assistant-eval-"));
  let repository;
  try {
    const { Repository } = require(resolve(root, "lib/store/index.ts"));
    const { seedStudio, demoDisruption } = require(resolve(root, "lib/seed/seed.ts"));
    const { replan } = require(resolve(root, "lib/solver/replan.ts"));
    const { executePlan } = require(resolve(root, "lib/executor/executePlan.ts"));
    const { requireLink, view } = require(resolve(root, "lib/choices/service.ts"));
    const { proposeChoice } = require(resolve(root, "lib/choices/assistant.ts"));
    repository = new Repository(directory);
    const state = seedStudio();
    for (const booking of state.bookings) booking.payment.simulated = true;
    const workspace = repository.createWorkspace(state);
    for (const booking of state.bookings) repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "capture", amount: booking.amount,
      paypalId: booking.payment.captureId, captureId: booking.payment.captureId, requestId: `capture:${booking.id}`, status: "SIMULATED" });
    const plan = repository.createPlan(workspace.id, replan(state, demoDisruption));
    await executePlan(workspace.id, plan.id, repository);
    const corpus = JSON.parse(readFileSync(resolve(root, "test/fixtures/customer-assistant-eval.json"), "utf8"));
    const link = repository.listCustomerLinks(workspace.id).find((entry) => entry.kind === "choice" && entry.before.title === "Yoga Flow"
      && matchesWhere({ ...entry.before, instructor: "" }, { weekday: "monday", at: "07:00" }, state.studio.timezone));
    if (!link) throw new Error(`Fixture booking unavailable: ${corpus.booking}`);
    const token = repository.customerToken(link), choice = view(requireLink(token, repository), repository);
    if (choice.refundable !== "22.00" || choice.after?.instructor !== "Alex Rivera") throw new Error("Fixture booking does not match its described recovery/refundable amount.");
    const started = performance.now(), rows = [];
    for (const item of corpus.items.slice(0, config.maxItems)) {
      if (performance.now() - started + 12_000 > config.budgetMs) break;
      const itemStarted = performance.now();
      try {
        const proposal = await proposeChoice(token, item.input, repository);
        rows.push({ id: item.id, category: item.category, ...proposal, ...scoreCase(item, proposal, choice), latencyMs: performance.now() - itemStarted });
      } catch (error) { rows.push({ id: item.id, category: item.category, correct: false, unsafe: false, error: error instanceof Error ? error.message : "Assistant failed", latencyMs: performance.now() - itemStarted }); }
      console.info(`Evaluated ${rows.length}/${Math.min(config.maxItems, corpus.items.length)} (item ${item.id}).`);
      if (performance.now() - started + config.delayMs + 12_000 > config.budgetMs) break;
      await delay(config.delayMs);
    }
    writeFileSync(resolve(root, "docs/customer-assistant-eval.md"), evaluationReport(rows, corpus.items.length, performance.now() - started, new RealDate().toISOString()));
    console.info(`Wrote docs/customer-assistant-eval.md (${rows.length}/${corpus.items.length} items).`);
  } finally { repository?.close(); globalThis.Date = RealDate; rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
