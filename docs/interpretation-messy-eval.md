# Live interpretation evaluation

Generated: 2026-10-28T13:14:19.002Z. Evaluated 45/45 corpus items in 294.6 s. Fixed studio clock: 2026-11-09 00:15 America/New_York; demo week: November 9–15, 2026.

Exact resource/window or clarification accuracy: 93.33%.
Rules-only baseline: 22/45 (48.89%); dangerous false positives: 0.
Dangerous false positives (must-clarify input produced a disruption): 0.
Rules result rate: 44.44% (includes safety clarifications before a provider call).
Rules fallback rate after a provider attempt: 2.22% (model mismatch or provider unavailable).
Provider outage/timeout fallback rate: 0.00%.
Median end-to-end interpretation latency: 1823.0 ms. Errors: 0.
Median latency when a model answered (25 items): 3430.7 ms. Results by source: gemini 9, groq 16, rules 20. Providers configured for this run: gemini, groq.

| Category | Correct / evaluated | Accuracy | Dangerous false positives | Rules results |
| --- | --- | --- | --- | --- |
| forwarded | 4/4 | 100.00% | 0 | 0.00% |
| third-person | 5/6 | 83.33% | 0 | 0.00% |
| long | 4/4 | 100.00% | 0 | 0.00% |
| hinglish | 2/3 | 66.67% | 0 | 33.33% |
| indian-english | 2/2 | 100.00% | 0 | 0.00% |
| rooms | 4/4 | 100.00% | 0 | 25.00% |
| closures | 0/1 | 0.00% | 0 | 0.00% |
| shorthand | 3/3 | 100.00% | 0 | 0.00% |
| must-clarify | 18/18 | 100.00% | 0 | 100.00% |

Full corpus size: 45; a bounded run is a subset, not a whole-corpus estimate. Items are selected round-robin across categories. One interpretation at a time; the production Gemini/Groq chain and its 12 s total deadline are used unchanged. No provider quotas or cooldowns are bypassed. Rules fallback can dominate a rate-limited run; inspect that rate before attributing accuracy to a model.

## Individual results

| ID | Category | Correct | Dangerous | Source | Model | Latency (ms) | Error |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | forwarded | true | false | groq | openai/gpt-oss-120b | 7208.2 |  |
| 5 | third-person | true | false | groq | openai/gpt-oss-120b | 1818.4 |  |
| 11 | long | true | false | groq | openai/gpt-oss-120b | 2094.6 |  |
| 15 | hinglish | true | false | groq | openai/gpt-oss-120b | 2686.7 |  |
| 18 | indian-english | true | false | groq | openai/gpt-oss-120b | 2221.4 |  |
| 20 | rooms | true | false | groq | openai/gpt-oss-120b | 7419.9 |  |
| 24 | closures | false | false | groq | openai/gpt-oss-120b | 1773.4 |  |
| 25 | shorthand | true | false | groq | openai/gpt-oss-20b | 7670.9 |  |
| 28 | must-clarify | true | false | rules | — | 0.1 |  |
| 2 | forwarded | true | false | groq | openai/gpt-oss-120b | 1228.6 |  |
| 6 | third-person | true | false | gemini | gemini-flash-lite-latest | 1312.2 |  |
| 12 | long | true | false | gemini | gemini-flash-lite-latest | 5249.2 |  |
| 16 | hinglish | true | false | gemini | gemini-flash-lite-latest | 3850.1 |  |
| 19 | indian-english | true | false | gemini | gemini-flash-lite-latest | 2763.0 |  |
| 21 | rooms | true | false | rules | — | 2429.2 |  |
| 26 | shorthand | true | false | gemini | gemini-flash-lite-latest | 3430.7 |  |
| 29 | must-clarify | true | false | rules | — | 0.7 |  |
| 3 | forwarded | true | false | gemini | gemini-flash-lite-latest | 3456.3 |  |
| 7 | third-person | false | false | gemini | gemini-flash-lite-latest | 4374.7 |  |
| 13 | long | true | false | groq | openai/gpt-oss-120b | 7659.8 |  |
| 17 | hinglish | false | false | rules | — | 1823.0 |  |
| 22 | rooms | true | false | groq | openai/gpt-oss-120b | 1952.5 |  |
| 27 | shorthand | true | false | groq | openai/gpt-oss-120b | 1686.7 |  |
| 30 | must-clarify | true | false | rules | — | 0.1 |  |
| 4 | forwarded | true | false | groq | openai/gpt-oss-120b | 1908.8 |  |
| 8 | third-person | true | false | gemini | gemini-flash-lite-latest | 4834.5 |  |
| 14 | long | true | false | gemini | gemini-flash-lite-latest | 3954.0 |  |
| 23 | rooms | true | false | groq | openai/gpt-oss-120b | 7808.0 |  |
| 31 | must-clarify | true | false | rules | — | 0.1 |  |
| 9 | third-person | true | false | groq | openai/gpt-oss-120b | 2591.1 |  |
| 32 | must-clarify | true | false | rules | — | 1271.4 |  |
| 10 | third-person | true | false | groq | openai/gpt-oss-20b | 9298.2 |  |
| 33 | must-clarify | true | false | rules | — | 0.5 |  |
| 34 | must-clarify | true | false | rules | — | 0.1 |  |
| 35 | must-clarify | true | false | rules | — | 0.2 |  |
| 36 | must-clarify | true | false | rules | — | 0.1 |  |
| 37 | must-clarify | true | false | rules | — | 7006.2 |  |
| 38 | must-clarify | true | false | rules | — | 0.6 |  |
| 39 | must-clarify | true | false | rules | — | 0.1 |  |
| 40 | must-clarify | true | false | rules | — | 1369.6 |  |
| 41 | must-clarify | true | false | rules | — | 0.1 |  |
| 42 | must-clarify | true | false | rules | — | 0.3 |  |
| 43 | must-clarify | true | false | rules | — | 0.1 |  |
| 44 | must-clarify | true | false | rules | — | 0.6 |  |
| 45 | must-clarify | true | false | rules | — | 0.1 |  |
