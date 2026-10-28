# Live interpretation evaluation

Generated: 2026-10-28T14:25:53.509Z. Evaluated 45/45 corpus items in 290.8 s. Fixed studio clock: 2026-11-09 00:15 America/New_York; demo week: November 9–15, 2026.

Exact resource/window or clarification accuracy: 88.89%.
Rules-only baseline: 22/45 (48.89%); dangerous false positives: 0.
Dangerous false positives (must-clarify input produced a disruption): 0.
Rules result rate: 55.56% (includes safety clarifications before a provider call).
Rules fallback rate after a provider attempt: 4.44% (model mismatch or provider unavailable).
Provider outage/timeout fallback rate: 2.22%.
Median end-to-end interpretation latency: 1655.9 ms. Errors: 0.
Median latency when a model answered (20 items): 1925.9 ms. Results by source: gemini 0, groq 20, rules 25. Providers configured for this run: gemini, groq.

| Category | Correct / evaluated | Accuracy | Dangerous false positives | Rules results |
| --- | --- | --- | --- | --- |
| forwarded | 3/4 | 75.00% | 0 | 25.00% |
| third-person | 5/6 | 83.33% | 0 | 16.67% |
| long | 2/4 | 50.00% | 0 | 75.00% |
| hinglish | 2/3 | 66.67% | 0 | 33.33% |
| indian-english | 2/2 | 100.00% | 0 | 0.00% |
| rooms | 4/4 | 100.00% | 0 | 0.00% |
| closures | 1/1 | 100.00% | 0 | 0.00% |
| shorthand | 3/3 | 100.00% | 0 | 33.33% |
| must-clarify | 18/18 | 100.00% | 0 | 100.00% |

Full corpus size: 45; a bounded run is a subset, not a whole-corpus estimate. Items are selected round-robin across categories. One interpretation at a time; the production Gemini/Groq chain and its 12 s total deadline are used unchanged. No provider quotas or cooldowns are bypassed. Rules fallback can dominate a rate-limited run; inspect that rate before attributing accuracy to a model.

## Individual results

| ID | Category | Correct | Dangerous | Source | Model | Latency (ms) | Error |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | forwarded | true | false | groq | openai/gpt-oss-120b | 7657.4 |  |
| 5 | third-person | true | false | groq | openai/gpt-oss-120b | 1654.6 |  |
| 11 | long | true | false | groq | openai/gpt-oss-120b | 1915.5 |  |
| 15 | hinglish | false | false | rules | — | 2931.6 |  |
| 18 | indian-english | true | false | groq | openai/gpt-oss-120b | 1558.9 |  |
| 20 | rooms | true | false | groq | openai/gpt-oss-120b | 2697.5 |  |
| 24 | closures | true | false | groq | openai/gpt-oss-120b | 4139.3 |  |
| 25 | shorthand | true | false | rules | — | 8016.7 |  |
| 28 | must-clarify | true | false | rules | — | 0.1 |  |
| 2 | forwarded | false | false | rules | — | 473.2 |  |
| 6 | third-person | false | false | rules | — | 447.2 |  |
| 12 | long | false | false | rules | — | 6520.1 |  |
| 16 | hinglish | true | false | groq | openai/gpt-oss-120b | 1655.9 |  |
| 19 | indian-english | true | false | groq | openai/gpt-oss-120b | 1703.4 |  |
| 21 | rooms | true | false | groq | openai/gpt-oss-120b | 1418.6 |  |
| 26 | shorthand | true | false | groq | openai/gpt-oss-120b | 2849.0 |  |
| 29 | must-clarify | true | false | rules | — | 0.7 |  |
| 3 | forwarded | true | false | groq | openai/gpt-oss-120b | 8539.7 |  |
| 7 | third-person | true | false | groq | openai/gpt-oss-120b | 1936.2 |  |
| 13 | long | true | false | rules | — | 3050.3 |  |
| 17 | hinglish | true | false | groq | openai/gpt-oss-120b | 4116.0 |  |
| 22 | rooms | true | false | groq | openai/gpt-oss-120b | 1574.2 |  |
| 27 | shorthand | true | false | groq | openai/gpt-oss-120b | 7540.6 |  |
| 30 | must-clarify | true | false | rules | — | 0.1 |  |
| 4 | forwarded | true | false | groq | openai/gpt-oss-120b | 2620.0 |  |
| 8 | third-person | true | false | groq | openai/gpt-oss-120b | 1855.6 |  |
| 14 | long | false | false | rules | — | 7439.1 |  |
| 23 | rooms | true | false | groq | openai/gpt-oss-120b | 8100.5 |  |
| 31 | must-clarify | true | false | rules | — | 0.0 |  |
| 9 | third-person | true | false | groq | openai/gpt-oss-120b | 1900.6 |  |
| 32 | must-clarify | true | false | rules | — | 2825.5 |  |
| 10 | third-person | true | false | groq | openai/gpt-oss-120b | 1502.9 |  |
| 33 | must-clarify | true | false | rules | — | 0.4 |  |
| 34 | must-clarify | true | false | rules | — | 0.1 |  |
| 35 | must-clarify | true | false | rules | — | 0.0 |  |
| 36 | must-clarify | true | false | rules | — | 0.1 |  |
| 37 | must-clarify | true | false | rules | — | 6857.4 |  |
| 38 | must-clarify | true | false | rules | — | 0.3 |  |
| 39 | must-clarify | true | false | rules | — | 0.1 |  |
| 40 | must-clarify | true | false | rules | — | 4963.9 |  |
| 41 | must-clarify | true | false | rules | — | 0.1 |  |
| 42 | must-clarify | true | false | rules | — | 0.2 |  |
| 43 | must-clarify | true | false | rules | — | 0.5 |  |
| 44 | must-clarify | true | false | rules | — | 1.4 |  |
| 45 | must-clarify | true | false | rules | — | 0.1 |  |
