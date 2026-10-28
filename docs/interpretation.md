# Scheduling interpretation

Interpretation returns either a disruption to review or `{ kind: "clarify", question, suggestions }`. Suggestions are complete replacement descriptions: tapping one sends that statement through interpretation again. Clarification never enables planning; the owner console and its WebMCP path both return the question without calling the plan endpoint. The panel focuses the question, labels its suggestion group with that question, and keeps the description editable.

The local safety and grounding pass runs before providers. Negated disruptions, hypothetical or historical events, corrections, unknown or multiple resources, missing days, ambiguous clocks, and dates outside the displayed week ask for clarification. Explicit negative availability statements such as “Alex not coming tmrw” confirm an absence; “Maya is not sick Monday” never creates one. First names and unambiguous single-edit typos are supported; a different full surname must be clarified. Short name typos remain conservative.

Model output is untrusted. It must resolve to an exact studio resource and the same locally grounded date/time window. Unknown names, changed days, widened closures, invented clocks, and invalid times fall back to the grounded result. Model notes cannot introduce facts into the review. Low-confidence output asks a question; structured model clarification is also supported. The interpretation call gives the shared Gemini/Groq transport a 12,000 ms total budget and a 6,000 ms per-attempt timeout, covering fetch and response-body reads even when abort is ignored. Other AI callers keep their existing deadlines.

## Window decision

`lib/domain/schemas.ts` defines disruptions as one continuous `from`/`to` window without a single-day restriction. `lib/solver/validate.ts` selects affected sessions by interval overlap; `lib/solver/replan.ts` evaluates all such upcoming sessions. `app/api/workspaces/[id]/plans/route.ts` requires that window to fit the displayed studio week. Therefore continuous multi-day windows are supported.

- “Monday to Wednesday” and “Monday through Wednesday” include both endpoints: Monday 00:00 through Thursday 00:00 in the studio timezone.
- “This week” covers the remaining displayed week, from the later of local today and its Monday, through Sunday inclusive. It never becomes only the first scheduled day.
- “Evenings this week”, separated days, and repeated daily periods require multiple windows, so ask for one day/time rather than joining the intervening available hours.
- “Until Wednesday” asks whether Wednesday is included. Suggestions offer an explicit single day or inclusive continuous range.
- A named single day with no time means all day, preserving the Maya hero flow. That assumption is visible before planning. A lone clock such as “at 2pm” asks for both endpoints. “After 2pm” means 14:00 to the next local midnight; “before 11am” means local midnight to 11:00. Morning is 07:00–12:00, afternoon 12:00–17:00, evening 17:00–21:00.

## Evaluation

`test/fixtures/interpret-eval.json` contains labelled inputs with exact local `YYYY-MM-DDTHH:mm` endpoints (end exclusive), studio resource names, or `clarify: true`. The fixed clock is November 9, 2026 at 00:15 America/New_York; the displayed week is November 9–15. Category coverage includes plain language, typos, Indian English, slang, clocks, rooms, closures, relative dates, ranges, and clarification safety cases.

Run the deterministic corpus without network:

```powershell
npx vitest run test/interpret-eval.test.ts --pool=threads --maxWorkers=1 --disableConsoleIntercept
```

The test requires zero dangerous false positives and at least 95% exact resource/window-or-clarification accuracy. This is an authored regression corpus, not an independent production accuracy estimate. A conservative clarification on a positive example counts as incorrect; an accepted disruption on any must-clarify example is a dangerous false positive and fails the test regardless of total accuracy.

Run the live chain manually with real keys (not in CI):

```powershell
node --env-file=.env.local scripts/eval-interpret.mjs --max-items 177 --budget-ms 2400000 --delay-ms 1500
```

The runner uses the production interpreter, concurrency one, a delay between items, a maximum item count and a total wall-time budget. It reserves a full 12-second interpretation deadline before starting each item. Defaults are 30 items, 120 seconds, and a 500 ms delay. Small runs sample categories round-robin. It writes `docs/interpretation-eval.md` with category accuracy, dangerous false positives, rules result rate, provider outage/timeout fallback rate, errors, coverage, per-item provider/model, and median end-to-end latency. Rules results include safety clarifications before a provider call; they must not be misreported as model accuracy. Existing provider quota and cooldown rules remain in force.

The latest live run, on October 28, 2026 with Gemini and Groq configured, scored 174/177 (98.31%) with 0 dangerous false positives; see [the live report](interpretation-eval.md).
