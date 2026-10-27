# Studio insights

Open `/w/<workspace-id>/dashboard` from Dashboard in the schedule header. **Week overview** shows booked revenue, recovery KPIs, class revenue, an instructor/day heatmap and sessions. **Disruptions** shows recovery impact, refund receipts, booking actions and refund reasons. **Money** shows net captured revenue, captures versus issued refunds by studio-local receipt day, receipts and the payment ledger. Each page has a description above its canvas.

Edit report opens Studio's layout and widget builder. Rebook's menu contains Recovery impact, Refund receipts, Week heatmap and Recovery metric. Heatmap cells show booked/capacity utilisation; hatching marks affected classes. Click a cell to cross-filter the page to its instructor **and** day. Click it again, or Clear selection, to clear it. The heatmap form controls percentages, mapping, titles and appearance.

Ask Recovery analyst opens Studio chat. Common questions use four typed, read-only tools computed from the loaded insight snapshot: `get_recovery_summary`, `get_refund_breakdown` (reason/class/status), `get_revenue_breakdown` (class type/instructor/day, booked versus kept) and `get_cover_summary`. Each returns the snapshot's `as_of` timestamp and has an expandable readable card. Counts reuse `lib/recovery/outcomes.ts`: after hero approval, 9 kept, 16 moved, 6 refunded, $577 retained and $135 refunded. No reply overlaps kept/moved; simulated refunds remain separate. Revenue breakdown includes unaffected bookings as well as recovery bookings, grouped by their current class/instructor/day. Booked is recorded gross booking value across statuses; kept subtracts settled refunds.

`add_preset_chart` places revenue by class type, refunds by reason, bookings by day, or kept/moved/refunded by disruption using the documented Studio `api.getState()` / `api.setState()` API. It immutably adds a configured chart to the selected page below existing widgets, preserving the other pages and reusing the same preset widget on repeat requests. Presets use live data mappings and normal Studio report persistence. Refund charts include completed and labelled simulated amounts; outcome charts separate simulated refunds and exclude proposals. Report filters apply to charts; direct answers cover the loaded workspace independently of report filters. If chart placement fails, the analyst is instructed to give the direct numbers and a short table.

Custom charts, report filters and layouts still delegate to Studio's built-in Data, Page, Widget and Planning specialists. The analyst's own roster contains only the compact direct tools, disruption/receipt lookups and delegation; it no longer advertises full query/schema/widget tools or embeds the full data schema. Offline tests exercise a mocked simple revenue question through the real SDK runner, adapter and proxy/Groq size gate in two model calls, without delegation. Delegation and the custom-tool shape host are mocked in that test; live provider routing and visual chart rendering remain manual checks.

Records refresh when the window regains focus or becomes visible; these events share a debounce and cooldown. Refresh in the page header reloads them on demand. A report rendering failure offers Try again.

Report state is stored in `localStorage` under `rebook:studio:<workspace-id>` with application version 3. Older saved layouts fall back to the three-page report. Restore default report resets this workspace's layout. A viewport-height flex shell and `ResizeObserver` fit the default 30-track layouts to the available canvas with explicit page padding. Tables, receipts and heatmap content scroll internally when needed. User-added widgets or larger edited layouts may require canvas scrolling.

## AG Studio features used

| Component | API | Where |
| --- | --- | --- |
| Report and pages | `AgStudio`, `AgReportState.pages`, `selectedPageId`, `getState` / `setState` | `components/insights/studio-report.tsx`, `lib/insights/report.ts`; three pages and saved state |
| Layout tools | `mode`, `layout.rowHeight`, `pagePadding`, `widgetLayout` tracks | Edit report; measured canvas and consistent row bounds |
| Theme | `studioTheme.withParams` | `lib/insights/theme.ts`; Rebook colours, typography, panels, cards, grids and chart palette |
| Custom widgets | React `createWidgets`, `AgWidgetDefinition`, `AgWidgetParams`, registry and menu | `components/insights/widgets.tsx`; impact, receipts, heatmap and recovery KPIs |
| Custom widget forms | `createDefaults`, `createWidgetAppearanceSection`, fieldsets, checkbox and select | Heatmap percentages, mapping and appearance; recovery selection and metric settings |
| Queries and empty states | `widgetApi.getData`, `setDisplayState('displayed')` | All custom widgets; empty recovery KPIs show `$0` / `-` and “No disruptions yet” |
| Cross-filtering | `toggleCrossFilter({ type: 'multiValue', group: 0, values })`, `getCrossFilterSelections`, `resetCrossFilter` | Heatmap instructor/day cells; one combination means instructor AND day |
| Relational data and expressions | `sources`, explicit `fields`, `relationships`, aggregate expressions | `lib/insights/studio-data.ts`; eight tables, an unambiguous join path, currency and net-revenue measures |
| Formatting | `dateFormat`, `dateTimeFormat`, `currencyFormat`, `formatOptions`, `createValueFormatter` | Local days such as Mon Oct 26, times such as 7:00 AM, HIIT/Yoga and title-case statuses; raw keys remain sortable |
| Built-in visualisations | `value`, `grid`, `bar-chart-grouped`, `column-chart-grouped` | Revenue, sessions, reasons, actions and Money charts/ledger |
| CSV export | Widget toolbar action `export`; `dataOptions.maxExportRows` | Grid/chart toolbars; formatted export limited to 10,000 rows |
| PNG download | Chart toolbar action `download` | Class revenue, refund reasons and cashflow charts |
| Agent framework | `AgStudioAiModule`, `createAiHarness`, `directLlmRunner`, builder `builtIn`, `tools.delegateTo` | `lib/insights/ai.ts`; analyst delegates to Studio's actual Data, Page, Planning and Widget agents |
| Custom tool components | `defineAiTool`, `ctx.success(response, data)`, `aiToolDisplay` with `label` and React `detail` | Recovery lookups and receipt cards in `components/insights/tool-cards.tsx` |
| Provider adapter | `AgLlmAdapter.executeTurn`, chunk events, response `stream` / `complete` | `lib/insights/gemini-adapter.ts`; live instructions/schemas, cancellation and Google signature preservation |

Studio 3.0.0 supports CSV on grids/charts and image download on charts. It exposes no built-in PNG action for tables or these custom widgets. Explicit toolbar buttons retain the built-in handlers.

## Data semantics

`GET /api/workspaces/[id]/insights` requires a ready workspace and omits customer emails and credentials. Money is numeric USD, converted through the domain cents helper. Local days remain date fields; zero-padded local times and status/class keys remain raw in the data and are formatted at display time. Timestamps use the studio timezone.

Cancelled sessions are recovered from applied plans' persisted basis so their bookings still join to a session. Each disruption is one plan, with proposed/applied status and cover descriptions. Revenue booked is gross booking value. Recovery KPIs include applied plans only; saved rate is `(kept + moved) / affected bookings`. Recovery impact labels proposed figures as forecasts. Fresh workspaces display explicit zero/dash recovery values and a caption instead of Studio's no-data overlay.

The heatmap queries session-level rows, including session ID, so equal-valued classes remain distinct and capacity is counted once per class. It sums booked and capacity for each instructor/day and divides those totals. Its source ignores cross-filter selections to keep the matrix available while other widgets filter.

`money_events` contains the latest ledger transition for each kind/request. Issued refunds and captures include COMPLETED and labelled SIMULATED amounts; pending/failed requests remain visible in receipts but do not enter issued totals. Net revenue is captures minus issued refunds. Money charts use receipt dates, which may differ from the scheduled class week. Revenue kept measures recovery interventions: repeated disruptions can count the same booking again. The report uses this workspace's ledger.

## AI proxy and configuration

- `GEMINI_API_KEY`, `GROQ_API_KEY`: server-only provider keys. Entries without their provider's key are skipped.
- `AI_MODELS`: ordered `provider:model` chain; defaults to `gemini:gemini-flash-lite-latest,groq:openai/gpt-oss-120b,gemini:gemini-3.5-flash,groq:openai/gpt-oss-20b,groq:qwen/qwen3.8-27b,gemini:gemini-flash-latest`. A client can prefer a configured model; arbitrary models/providers cannot be added by the client.
- `GEMINI_MODELS`: legacy all-Gemini chain, used only when `AI_MODELS` is unset. Existing deployments keep that behavior until they unset it or configure `AI_MODELS`.
- `GROQ_MAX_INPUT_TOKENS`: input size gate, default `7000`. The estimate is `ceil(UTF-8 bytes of the complete provider JSON body / 8)`, measured on real Studio turns (a 28 KB analyst turn is 1,803 Groq tokens; a 51 KB delegated Page-agent turn is 6,205). Over-limit Groq entries log `too_large` without making a request or consuming a local quota attempt; the largest delegated turns (about 80 KB and up) stay on Gemini. Groq's free tier allows about 8,000 tokens per minute per model (Qwen: 7,000 input tokens), so each Groq model takes roughly one large turn per minute; a 413 or 429 moves on to the next model.
- `NEXT_PUBLIC_AG_STUDIO_LICENSE`: optional public Studio licence key; without it, expect trial warnings/watermark.

`POST /api/workspaces/[id]/llm` validates workspace and request. Harness turns identify themselves with `X-Rebook-Studio: harness`; the body is capped at 262,144 bytes and accepts only known agents and their local Studio tool names. Live per-widget schemas/instructions sit beneath a server-owned workspace policy. Unknown tools, provider-hosted tools and cross-agent tool rosters are rejected. Older clients retain the narrow server-defined tool contract and 65,536-byte body cap.

Gemini first; Groq takes small requests when Gemini is busy. The fixed OpenAI-compatible Chat Completions endpoints are `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` and `https://api.groq.com/openai/v1/chat/completions`. Both use POST with JSON and Bearer authentication. Non-streaming output is capped at 4,096 tokens. The first entry with credentials gets 10 seconds; later entries get up to 20 seconds within a 35-second overall budget, including response-body reads. Cooldowns are per `provider:model` across Studio agents and disruption interpretation: 429 honors `Retry-After` seconds or HTTP dates, capped at 60 seconds (otherwise 30 seconds); 503/timeouts use 30 seconds. Groq 413 logs `too_large` and continues without a cooldown. Authentication failures skip the remaining entries for that provider during the current request, allowing the other provider to continue.

Structured `ai_call` logs contain only `message`, `provider`, `model`, `status`, and elapsed `ms`; no prompts, response bodies, credentials, URLs or upstream error text. The shared process-local limiter defaults to 24 attempts/minute for each client and workspace, 60/minute globally, 1,200/day and 6 concurrent calls (sized for the Gemini + Groq chain and three parallel delegated turns); each upstream attempt counts, and a local limit stop is logged as `local_limit`. Larger deployments need shared limit storage. Credentials never reach the browser.

Disruption interpretation shares this chain and converts its existing response schema to standard JSON Schema. Output is parsed and validated before resolving names/times; it reports the actual provider, and retains the local rules fallback. Optional explanation rephrasing shares the chain and retains its deterministic number checks/template fallback.

Both chat contracts accept at most 256 KiB of UTF-8 JSON, with readable 413/400 errors above the limit. Delegated turns include live schemas, report state and tool results; the regression fixture measures 50,381 bytes. The browser aborts each call after 45 seconds. Provider failures reject the adapter's stream and completion, and child failures propagate to the owning chat as a terminal error. A 210-second deadline covers the entire run, including up to two short waits per turn when every model is briefly rate-limited (a chart request takes about eight model steps), including parallel delegates, so an outage ends with “The analyst is busy right now — try again in a moment.” Manual cancellation remains cancellation.

The adapter retains Google's complete `extra_content`, including thought signatures, on call items and in a call-ID sidecar. It regroups Studio's interleaved call/result pairs into Chat Completions assistant turns. Gemini requests preserve signatures and add the documented placeholder to injected calls. Groq requests remove `extra_content` from messages and tool calls, retaining standard tools, tool choices (including required/named function), JSON Schema response format and token caps. Groq responses receive missing tool-call IDs before the existing Zod validation; provider metadata is stripped. Chat history is in memory; only report state is persisted.

## API limits

The custom `formatShape` uses the public `defineAiCommand(...).shape` bridge because Studio exports no standalone shape-builder constructor. Studio 3.0.0's `overrides` generic resolves to `never` for a registry with custom widget types, so export buttons use the returned widget definitions' public `toolbar` property and retain the built-in action handlers.

## Verified (2026-10-27)

- Offline tests cover report mappings/layout bounds, heatmap aggregation, formatting, tool cards, delegation configuration and provider schema forwarding.
- Offline refresh tests cover focus/visibility debounce, one request at a time, manual refresh, cleanup, expiry and recoverable errors. The report has a retry boundary; a failed data refresh retains the last loaded records.
