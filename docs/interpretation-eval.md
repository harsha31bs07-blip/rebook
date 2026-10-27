# Interpretation evaluation

Live providers have **not** been evaluated in this task. No model accuracy or latency result is claimed here. Running the manual script below replaces this file with the live report.

The deterministic rules corpus contains **177** labelled statements. The rules test measured **176/177 (99.44%)** exact resource/window-or-clarification accuracy and **0 dangerous false positives** across **94 must-clarify cases**. The minimum asserted accuracy is **95%**, independently of the zero-dangerous-results requirement.

| Category | Correct / total |
| --- | --- |
| Plain | 15/15 |
| Typos | 5/6 |
| Indian English | 10/10 |
| Informal / slang | 10/10 |
| Time windows | 14/14 |
| Rooms | 10/10 |
| Closures | 5/5 |
| Relative dates | 6/6 |
| Continuous ranges | 7/7 |
| Negation | 15/15 |
| Hypotheticals | 12/12 |
| Corrections | 9/9 |
| Past events | 8/8 |
| Unknown resources | 11/11 |
| Multiple resources | 5/5 |
| Unsupported ranges | 11/11 |
| Missing day / time | 15/15 |
| Safety regressions | 8/8 |

The sole miss is “Mya has flu Mon”: the parser asks which instructor is meant rather than matching a name shorter than four characters fuzzily. This is a conservative false negative. This authored regression corpus does not establish production accuracy; the parser was developed against it.

Run the offline corpus:

```powershell
npx vitest run test/interpret-eval.test.ts --pool=threads --maxWorkers=1 --disableConsoleIntercept
```

Run the live provider chain manually, with real keys in `.env.local`:

```powershell
node --env-file=.env.local scripts/eval-interpret.mjs --max-items 177 --budget-ms 2400000 --delay-ms 1500
```

Concurrency is one; each interpretation has at most 12 seconds across providers. The script caps total items and total run time, delays between items, preserves quotas/cooldowns, and reports accuracy per category, dangerous false positives, rules/outage fallback rates, median latency, errors, coverage and per-item provider/model. Review [the window decisions and evaluation limits](interpretation.md).
