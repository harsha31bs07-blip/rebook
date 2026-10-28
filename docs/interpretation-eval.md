# Live interpretation evaluation

Generated: 2026-10-28T11:23:01.326Z. Evaluated 177/177 corpus items in 413.6 s. Fixed studio clock: 2026-11-09 00:15 America/New_York; demo week: November 9–15, 2026.

Exact resource/window or clarification accuracy: 98.31%.
Dangerous false positives (must-clarify input produced a disruption): 0.
Rules result rate: 55.93% (includes safety clarifications before a provider call).
Rules fallback rate after a provider attempt: 2.26% (model mismatch or provider unavailable).
Provider outage/timeout fallback rate: 0.56%.
Median end-to-end interpretation latency: 0.6 ms. Errors: 0.
Median latency when a model answered (78 items): 1389.0 ms. Results by source: gemini 75, groq 3, rules 99. Providers configured for this run: gemini, groq.

| Category | Correct / evaluated | Accuracy | Dangerous false positives | Rules results |
| --- | --- | --- | --- | --- |
| plain | 15/15 | 100.00% | 0 | 0.00% |
| typos | 3/6 | 50.00% | 0 | 16.67% |
| indian-english | 10/10 | 100.00% | 0 | 0.00% |
| informal | 10/10 | 100.00% | 0 | 0.00% |
| time-windows | 14/14 | 100.00% | 0 | 14.29% |
| rooms | 10/10 | 100.00% | 0 | 10.00% |
| closures | 5/5 | 100.00% | 0 | 0.00% |
| relative-dates | 6/6 | 100.00% | 0 | 16.67% |
| ranges | 7/7 | 100.00% | 0 | 0.00% |
| negation | 15/15 | 100.00% | 0 | 100.00% |
| hypothetical | 12/12 | 100.00% | 0 | 100.00% |
| corrections | 9/9 | 100.00% | 0 | 100.00% |
| past | 8/8 | 100.00% | 0 | 100.00% |
| unknown | 11/11 | 100.00% | 0 | 100.00% |
| multiple-resources | 5/5 | 100.00% | 0 | 100.00% |
| unsupported-ranges | 11/11 | 100.00% | 0 | 100.00% |
| missing-day-time | 15/15 | 100.00% | 0 | 100.00% |
| safety-regressions | 8/8 | 100.00% | 0 | 100.00% |

Full corpus size: 177; a bounded run is a subset, not a whole-corpus estimate. Items are selected round-robin across categories. One interpretation at a time; the production Gemini/Groq chain and its 12 s total deadline are used unchanged. No provider quotas or cooldowns are bypassed. Rules fallback can dominate a rate-limited run; inspect that rate before attributing accuracy to a model.

## Reading the misses

All three misses are typos, and none of them is dangerous. For “Myaa is sick Monday” and “Mayaa unavailable Monday” the model asks “Did you mean Maya Chen?” instead of guessing. For “Mya has flu Mon” the rules decline to fuzzy-match a name shorter than four characters and ask which instructor is meant. The scorer counts a confirmation question as a miss because the corpus expects the resolved disruption.

Every model answer must also agree with the deterministic rules parser, or Rebook falls back to the rules result or asks a question. A model can therefore make the product more cautious, but it cannot invent a disruption. The 177 statements are an authored regression corpus, not a sample of real owner messages.

## How to rerun

Offline corpus (rules only, no keys):

```powershell
npx vitest run test/interpret-eval.test.ts --pool=threads --maxWorkers=1 --disableConsoleIntercept
```

Live provider chain, with real keys in `.env.local` (`GEMINI_API_KEY`, optional `GROQ_API_KEY`):

```powershell
node --env-file=.env.local scripts/eval-interpret.mjs --max-items 177 --budget-ms 2400000 --delay-ms 1500
```

Concurrency is one; each interpretation has at most 12 seconds across providers. See [the window decisions and evaluation limits](interpretation.md).

## Individual results

| ID | Category | Correct | Dangerous | Source | Model | Latency (ms) | Error |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | plain | true | false | gemini | gemini-flash-lite-latest | 3808.3 |  |
| 16 | typos | false | false | gemini | gemini-flash-lite-latest | 1258.0 |  |
| 22 | indian-english | true | false | gemini | gemini-flash-lite-latest | 1221.2 |  |
| 32 | informal | true | false | gemini | gemini-flash-lite-latest | 1277.0 |  |
| 42 | time-windows | true | false | gemini | gemini-flash-lite-latest | 1112.6 |  |
| 56 | rooms | true | false | rules | — | 12019.6 |  |
| 66 | closures | true | false | groq | openai/gpt-oss-120b | 1756.5 |  |
| 71 | relative-dates | true | false | groq | openai/gpt-oss-120b | 2057.9 |  |
| 77 | ranges | true | false | groq | openai/gpt-oss-120b | 2103.3 |  |
| 83 | negation | true | false | rules | — | 0.5 |  |
| 98 | hypothetical | true | false | rules | — | 0.1 |  |
| 110 | corrections | true | false | rules | — | 0.1 |  |
| 119 | past | true | false | rules | — | 0.2 |  |
| 127 | unknown | true | false | rules | — | 0.6 |  |
| 138 | multiple-resources | true | false | rules | — | 0.3 |  |
| 143 | unsupported-ranges | true | false | rules | — | 0.4 |  |
| 154 | missing-day-time | true | false | rules | — | 0.3 |  |
| 169 | safety-regressions | true | false | rules | — | 0.4 |  |
| 2 | plain | true | false | gemini | gemini-flash-lite-latest | 1670.6 |  |
| 17 | typos | false | false | rules | — | 0.4 |  |
| 23 | indian-english | true | false | gemini | gemini-flash-lite-latest | 4924.8 |  |
| 33 | informal | true | false | gemini | gemini-flash-lite-latest | 3046.7 |  |
| 43 | time-windows | true | false | gemini | gemini-flash-lite-latest | 1387.3 |  |
| 57 | rooms | true | false | gemini | gemini-flash-lite-latest | 1312.5 |  |
| 67 | closures | true | false | gemini | gemini-flash-lite-latest | 1408.3 |  |
| 72 | relative-dates | true | false | gemini | gemini-flash-lite-latest | 1618.8 |  |
| 78 | ranges | true | false | gemini | gemini-flash-lite-latest | 3219.5 |  |
| 84 | negation | true | false | rules | — | 0.2 |  |
| 99 | hypothetical | true | false | rules | — | 0.1 |  |
| 111 | corrections | true | false | rules | — | 0.1 |  |
| 120 | past | true | false | rules | — | 0.2 |  |
| 128 | unknown | true | false | rules | — | 0.5 |  |
| 139 | multiple-resources | true | false | rules | — | 0.5 |  |
| 144 | unsupported-ranges | true | false | rules | — | 0.6 |  |
| 155 | missing-day-time | true | false | rules | — | 0.4 |  |
| 170 | safety-regressions | true | false | rules | — | 0.1 |  |
| 3 | plain | true | false | gemini | gemini-flash-lite-latest | 1858.6 |  |
| 18 | typos | false | false | gemini | gemini-flash-lite-latest | 991.7 |  |
| 24 | indian-english | true | false | gemini | gemini-flash-lite-latest | 1153.5 |  |
| 34 | informal | true | false | gemini | gemini-flash-lite-latest | 2784.4 |  |
| 44 | time-windows | true | false | gemini | gemini-flash-lite-latest | 1285.1 |  |
| 58 | rooms | true | false | gemini | gemini-flash-lite-latest | 950.0 |  |
| 68 | closures | true | false | gemini | gemini-flash-lite-latest | 1340.1 |  |
| 73 | relative-dates | true | false | gemini | gemini-flash-lite-latest | 1160.6 |  |
| 79 | ranges | true | false | gemini | gemini-flash-lite-latest | 1309.5 |  |
| 85 | negation | true | false | rules | — | 0.1 |  |
| 100 | hypothetical | true | false | rules | — | 0.1 |  |
| 112 | corrections | true | false | rules | — | 0.0 |  |
| 121 | past | true | false | rules | — | 0.1 |  |
| 129 | unknown | true | false | rules | — | 0.3 |  |
| 140 | multiple-resources | true | false | rules | — | 0.2 |  |
| 145 | unsupported-ranges | true | false | rules | — | 0.2 |  |
| 156 | missing-day-time | true | false | rules | — | 0.5 |  |
| 171 | safety-regressions | true | false | rules | — | 0.1 |  |
| 4 | plain | true | false | gemini | gemini-flash-lite-latest | 1255.3 |  |
| 19 | typos | true | false | gemini | gemini-flash-lite-latest | 1052.4 |  |
| 25 | indian-english | true | false | gemini | gemini-flash-lite-latest | 1181.2 |  |
| 35 | informal | true | false | gemini | gemini-flash-lite-latest | 1467.5 |  |
| 45 | time-windows | true | false | gemini | gemini-flash-lite-latest | 1146.9 |  |
| 59 | rooms | true | false | gemini | gemini-flash-lite-latest | 1155.4 |  |
| 69 | closures | true | false | gemini | gemini-flash-lite-latest | 990.7 |  |
| 74 | relative-dates | true | false | gemini | gemini-flash-lite-latest | 1234.4 |  |
| 80 | ranges | true | false | gemini | gemini-flash-lite-latest | 1821.2 |  |
| 86 | negation | true | false | rules | — | 0.1 |  |
| 101 | hypothetical | true | false | rules | — | 0.1 |  |
| 113 | corrections | true | false | rules | — | 0.1 |  |
| 122 | past | true | false | rules | — | 0.1 |  |
| 130 | unknown | true | false | rules | — | 0.4 |  |
| 141 | multiple-resources | true | false | rules | — | 0.5 |  |
| 146 | unsupported-ranges | true | false | rules | — | 0.4 |  |
| 157 | missing-day-time | true | false | rules | — | 1.4 |  |
| 172 | safety-regressions | true | false | rules | — | 0.1 |  |
| 5 | plain | true | false | gemini | gemini-flash-lite-latest | 1149.6 |  |
| 20 | typos | true | false | gemini | gemini-flash-lite-latest | 1192.4 |  |
| 26 | indian-english | true | false | gemini | gemini-flash-lite-latest | 1900.2 |  |
| 36 | informal | true | false | gemini | gemini-flash-lite-latest | 1126.2 |  |
| 46 | time-windows | true | false | gemini | gemini-flash-lite-latest | 3702.6 |  |
| 60 | rooms | true | false | gemini | gemini-flash-lite-latest | 2603.1 |  |
| 70 | closures | true | false | gemini | gemini-flash-lite-latest | 1639.7 |  |
| 75 | relative-dates | true | false | gemini | gemini-flash-lite-latest | 1516.4 |  |
| 81 | ranges | true | false | gemini | gemini-flash-lite-latest | 1570.3 |  |
| 87 | negation | true | false | rules | — | 0.0 |  |
| 102 | hypothetical | true | false | rules | — | 0.1 |  |
| 114 | corrections | true | false | rules | — | 0.1 |  |
| 123 | past | true | false | rules | — | 0.1 |  |
| 131 | unknown | true | false | rules | — | 0.6 |  |
| 142 | multiple-resources | true | false | rules | — | 0.2 |  |
| 147 | unsupported-ranges | true | false | rules | — | 0.6 |  |
| 158 | missing-day-time | true | false | rules | — | 0.7 |  |
| 173 | safety-regressions | true | false | rules | — | 0.2 |  |
| 6 | plain | true | false | gemini | gemini-flash-lite-latest | 1406.2 |  |
| 21 | typos | true | false | gemini | gemini-flash-lite-latest | 1390.8 |  |
| 27 | indian-english | true | false | gemini | gemini-flash-lite-latest | 1288.7 |  |
| 37 | informal | true | false | gemini | gemini-flash-lite-latest | 1297.6 |  |
| 47 | time-windows | true | false | gemini | gemini-flash-lite-latest | 4905.5 |  |
| 61 | rooms | true | false | gemini | gemini-flash-lite-latest | 2296.1 |  |
| 76 | relative-dates | true | false | rules | — | 1639.9 |  |
| 82 | ranges | true | false | gemini | gemini-flash-lite-latest | 3122.4 |  |
| 88 | negation | true | false | rules | — | 0.1 |  |
| 103 | hypothetical | true | false | rules | — | 0.1 |  |
| 115 | corrections | true | false | rules | — | 0.1 |  |
| 124 | past | true | false | rules | — | 0.1 |  |
| 132 | unknown | true | false | rules | — | 0.3 |  |
| 148 | unsupported-ranges | true | false | rules | — | 0.1 |  |
| 159 | missing-day-time | true | false | rules | — | 0.3 |  |
| 174 | safety-regressions | true | false | rules | — | 0.4 |  |
| 7 | plain | true | false | gemini | gemini-flash-lite-latest | 1457.9 |  |
| 28 | indian-english | true | false | gemini | gemini-flash-lite-latest | 1375.9 |  |
| 38 | informal | true | false | gemini | gemini-flash-lite-latest | 1353.1 |  |
| 48 | time-windows | true | false | rules | — | 2814.8 |  |
| 62 | rooms | true | false | gemini | gemini-flash-lite-latest | 1443.2 |  |
| 177 | ranges | true | false | gemini | gemini-flash-lite-latest | 1627.5 |  |
| 89 | negation | true | false | rules | — | 0.0 |  |
| 104 | hypothetical | true | false | rules | — | 0.1 |  |
| 116 | corrections | true | false | rules | — | 0.1 |  |
| 125 | past | true | false | rules | — | 0.2 |  |
| 133 | unknown | true | false | rules | — | 0.2 |  |
| 149 | unsupported-ranges | true | false | rules | — | 0.1 |  |
| 160 | missing-day-time | true | false | rules | — | 0.4 |  |
| 175 | safety-regressions | true | false | rules | — | 0.1 |  |
| 8 | plain | true | false | gemini | gemini-flash-lite-latest | 1422.2 |  |
| 29 | indian-english | true | false | gemini | gemini-flash-lite-latest | 3456.2 |  |
| 39 | informal | true | false | gemini | gemini-flash-lite-latest | 1507.3 |  |
| 49 | time-windows | true | false | gemini | gemini-flash-lite-latest | 1068.1 |  |
| 63 | rooms | true | false | gemini | gemini-flash-lite-latest | 1835.0 |  |
| 90 | negation | true | false | rules | — | 0.1 |  |
| 105 | hypothetical | true | false | rules | — | 0.0 |  |
| 117 | corrections | true | false | rules | — | 0.0 |  |
| 126 | past | true | false | rules | — | 0.1 |  |
| 134 | unknown | true | false | rules | — | 0.1 |  |
| 150 | unsupported-ranges | true | false | rules | — | 0.4 |  |
| 161 | missing-day-time | true | false | rules | — | 0.6 |  |
| 176 | safety-regressions | true | false | rules | — | 0.5 |  |
| 9 | plain | true | false | gemini | gemini-flash-lite-latest | 1642.0 |  |
| 30 | indian-english | true | false | gemini | gemini-flash-lite-latest | 1343.1 |  |
| 40 | informal | true | false | gemini | gemini-flash-lite-latest | 1108.7 |  |
| 50 | time-windows | true | false | gemini | gemini-flash-lite-latest | 1200.0 |  |
| 64 | rooms | true | false | gemini | gemini-flash-lite-latest | 1606.2 |  |
| 91 | negation | true | false | rules | — | 0.1 |  |
| 106 | hypothetical | true | false | rules | — | 0.1 |  |
| 118 | corrections | true | false | rules | — | 0.1 |  |
| 135 | unknown | true | false | rules | — | 0.3 |  |
| 151 | unsupported-ranges | true | false | rules | — | 0.3 |  |
| 162 | missing-day-time | true | false | rules | — | 0.6 |  |
| 10 | plain | true | false | gemini | gemini-flash-lite-latest | 1549.8 |  |
| 31 | indian-english | true | false | gemini | gemini-flash-lite-latest | 1053.0 |  |
| 41 | informal | true | false | gemini | gemini-flash-lite-latest | 1130.3 |  |
| 51 | time-windows | true | false | gemini | gemini-flash-lite-latest | 1338.6 |  |
| 65 | rooms | true | false | gemini | gemini-flash-lite-latest | 939.7 |  |
| 92 | negation | true | false | rules | — | 0.1 |  |
| 107 | hypothetical | true | false | rules | — | 0.1 |  |
| 136 | unknown | true | false | rules | — | 0.2 |  |
| 152 | unsupported-ranges | true | false | rules | — | 0.1 |  |
| 163 | missing-day-time | true | false | rules | — | 0.7 |  |
| 11 | plain | true | false | gemini | gemini-flash-lite-latest | 1423.6 |  |
| 52 | time-windows | true | false | gemini | gemini-flash-lite-latest | 1416.5 |  |
| 93 | negation | true | false | rules | — | 0.1 |  |
| 108 | hypothetical | true | false | rules | — | 0.1 |  |
| 137 | unknown | true | false | rules | — | 0.0 |  |
| 153 | unsupported-ranges | true | false | rules | — | 0.9 |  |
| 164 | missing-day-time | true | false | rules | — | 0.5 |  |
| 12 | plain | true | false | gemini | gemini-flash-lite-latest | 976.3 |  |
| 53 | time-windows | true | false | rules | — | 1112.7 |  |
| 94 | negation | true | false | rules | — | 0.1 |  |
| 109 | hypothetical | true | false | rules | — | 0.1 |  |
| 165 | missing-day-time | true | false | rules | — | 0.6 |  |
| 13 | plain | true | false | gemini | gemini-flash-lite-latest | 1136.5 |  |
| 54 | time-windows | true | false | gemini | gemini-flash-lite-latest | 1549.7 |  |
| 95 | negation | true | false | rules | — | 0.1 |  |
| 166 | missing-day-time | true | false | rules | — | 0.3 |  |
| 14 | plain | true | false | gemini | gemini-flash-lite-latest | 968.4 |  |
| 55 | time-windows | true | false | gemini | gemini-flash-lite-latest | 1199.0 |  |
| 96 | negation | true | false | rules | — | 0.1 |  |
| 167 | missing-day-time | true | false | rules | — | 0.8 |  |
| 15 | plain | true | false | gemini | gemini-flash-lite-latest | 1494.7 |  |
| 97 | negation | true | false | rules | — | 0.1 |  |
| 168 | missing-day-time | true | false | rules | — | 0.6 |  |
