# Live interpretation evaluation

Generated: 2026-10-29T10:55:57.001Z. Evaluated 45/45 corpus items in 298.6 s. Fixed studio clock: 2026-11-09 00:15 America/New_York; demo week: November 9–15, 2026.

Exact resource/window or clarification accuracy: 95.56%.
Rules-only baseline: 22/45 (48.89%); dangerous false positives: 0.
Dangerous false positives (must-clarify input produced a disruption): 0.
Rules result rate: 44.44% (includes safety clarifications before a provider call).
Rules fallback rate after a provider attempt: 0.00% (model mismatch or provider unavailable).
Provider outage/timeout fallback rate: 0.00%.
Median end-to-end interpretation latency: 1766.3 ms. Errors: 0.
Median latency when a model answered (25 items): 2455.6 ms. Results by source: gemini 2, groq 23, rules 20. Providers configured for this run: gemini, groq.

| Category | Correct / evaluated | Accuracy | Dangerous false positives | Rules results |
| --- | --- | --- | --- | --- |
| forwarded | 4/4 | 100.00% | 0 | 0.00% |
| third-person | 5/6 | 83.33% | 0 | 16.67% |
| long | 4/4 | 100.00% | 0 | 0.00% |
| hinglish | 3/3 | 100.00% | 0 | 0.00% |
| indian-english | 2/2 | 100.00% | 0 | 0.00% |
| rooms | 4/4 | 100.00% | 0 | 0.00% |
| closures | 1/1 | 100.00% | 0 | 0.00% |
| shorthand | 2/3 | 66.67% | 0 | 33.33% |
| must-clarify | 18/18 | 100.00% | 0 | 100.00% |

Full corpus size: 45; a bounded run is a subset, not a whole-corpus estimate. Items are selected round-robin across categories. One interpretation at a time; the production Gemini/Groq chain and its 12 s total deadline are used unchanged. No provider quotas or cooldowns are bypassed. Rules fallback can dominate a rate-limited run; inspect that rate before attributing accuracy to a model.

## Individual results

| ID | Category | Correct | Dangerous | Source | Model | Latency (ms) | Error |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | forwarded | true | false | groq | openai/gpt-oss-120b | 8090.6 |  |
| 5 | third-person | true | false | groq | openai/gpt-oss-120b | 1803.3 |  |
| 11 | long | true | false | groq | openai/gpt-oss-120b | 1900.6 |  |
| 15 | hinglish | true | false | groq | openai/gpt-oss-120b | 1654.8 |  |
| 18 | indian-english | true | false | groq | openai/gpt-oss-20b | 7117.7 |  |
| 20 | rooms | true | false | groq | openai/gpt-oss-120b | 7832.6 |  |
| 24 | closures | true | false | groq | openai/gpt-oss-120b | 1994.7 |  |
| 25 | shorthand | true | false | groq | openai/gpt-oss-20b | 1431.5 |  |
| 28 | must-clarify | true | false | rules | — | 0.1 |  |
| 2 | forwarded | true | false | groq | openai/gpt-oss-120b | 2455.6 |  |
| 6 | third-person | true | false | groq | openai/gpt-oss-120b | 1952.5 |  |
| 12 | long | true | false | gemini | gemini-3.5-flash | 11601.9 |  |
| 16 | hinglish | true | false | groq | openai/gpt-oss-120b | 1766.3 |  |
| 19 | indian-english | true | false | groq | openai/gpt-oss-20b | 3107.5 |  |
| 21 | rooms | true | false | groq | openai/gpt-oss-120b | 1653.3 |  |
| 26 | shorthand | true | false | groq | openai/gpt-oss-120b | 2195.4 |  |
| 29 | must-clarify | true | false | rules | — | 0.8 |  |
| 3 | forwarded | true | false | groq | openai/gpt-oss-120b | 8176.3 |  |
| 7 | third-person | true | false | groq | openai/gpt-oss-120b | 3358.2 |  |
| 13 | long | true | false | groq | openai/gpt-oss-20b | 5078.3 |  |
| 17 | hinglish | true | false | groq | openai/gpt-oss-120b | 2521.2 |  |
| 22 | rooms | true | false | groq | openai/gpt-oss-120b | 1592.9 |  |
| 27 | shorthand | false | false | rules | — | 7468.3 |  |
| 30 | must-clarify | true | false | rules | — | 0.1 |  |
| 4 | forwarded | true | false | groq | openai/gpt-oss-120b | 3279.8 |  |
| 8 | third-person | true | false | groq | openai/gpt-oss-120b | 1603.4 |  |
| 14 | long | true | false | groq | openai/gpt-oss-120b | 2119.5 |  |
| 23 | rooms | true | false | gemini | gemini-3.5-flash | 4070.0 |  |
| 31 | must-clarify | true | false | rules | — | 0.1 |  |
| 9 | third-person | true | false | groq | openai/gpt-oss-120b | 7547.6 |  |
| 32 | must-clarify | true | false | rules | — | 1627.8 |  |
| 10 | third-person | false | false | rules | — | 4135.6 |  |
| 33 | must-clarify | true | false | rules | — | 0.3 |  |
| 34 | must-clarify | true | false | rules | — | 0.1 |  |
| 35 | must-clarify | true | false | rules | — | 0.2 |  |
| 36 | must-clarify | true | false | rules | — | 0.1 |  |
| 37 | must-clarify | true | false | rules | — | 1682.0 |  |
| 38 | must-clarify | true | false | rules | — | 0.6 |  |
| 39 | must-clarify | true | false | rules | — | 0.0 |  |
| 40 | must-clarify | true | false | rules | — | 7458.6 |  |
| 41 | must-clarify | true | false | rules | — | 0.0 |  |
| 42 | must-clarify | true | false | rules | — | 0.2 |  |
| 43 | must-clarify | true | false | rules | — | 0.0 |  |
| 44 | must-clarify | true | false | rules | — | 0.7 |  |
| 45 | must-clarify | true | false | rules | — | 0.1 |  |
