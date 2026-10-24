# Studio insights

Open `/w/<workspace-id>/dashboard` from Dashboard in the schedule header. **Week overview** shows booked revenue, recovery KPIs, class revenue, an instructor/day heatmap and sessions. **Disruptions** shows recovery impact, refund receipts, booking actions and refund reasons. **Money** shows net captured revenue, captures versus issued refunds by studio-local receipt day, receipts and the payment ledger. Each page has a description above its canvas.

Edit report opens Studio's layout and widget builder. Rebook's menu contains Recovery impact, Refund receipts, Week heatmap and Recovery metric. Heatmap cells show booked/capacity utilisation; hatching marks affected classes. Click a cell to cross-filter the page to its instructor **and** day. Click it again, or Clear selection, to clear it. The heatmap form controls percentages, mapping, titles and appearance.

Ask Recovery analyst opens Studio chat. “Show refunds by reason as a chart” delegates placement to Studio's built-in Page agent and configuration to its Widget agent. “Filter to Maya's classes” delegates a real page filter. Data and Planning specialists are also available. The proxy forwards Studio's live, narrowed schemas, including `delegate_to` and the `complete_task` tool injected into child runs. Friendly expandable tool cards say “Looked up 1 disruption” and “Read 5 refund receipts”.

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

Studio 3.0.0 supports CSV on grids/charts and image download on charts. It exposes no built-in PNG action for tables or these custom widgets. The supplied reference folder has no `exporting.md`; support was confirmed in `widget-configuration.md` (Toolbar Actions) and installed source. Explicit toolbar buttons retain the built-in handlers.

## Data semantics

`GET /api/workspaces/[id]/insights` requires a ready workspace and omits customer emails and credentials. Money is numeric USD, converted through the domain cents helper. Local days remain date fields; zero-padded local times and status/class keys remain raw in the data and are formatted at display time. Timestamps use the studio timezone.

Cancelled sessions are recovered from applied plans' persisted basis so their bookings still join to a session. Each disruption is one plan, with proposed/applied status and cover descriptions. Revenue booked is gross booking value. Recovery KPIs include applied plans only; saved rate is `(kept + moved) / affected bookings`. Recovery impact labels proposed figures as forecasts. Fresh workspaces display explicit zero/dash recovery values and a caption instead of Studio's no-data overlay.

The heatmap queries session-level rows, including session ID, so equal-valued classes remain distinct and capacity is counted once per class. It sums booked and capacity for each instructor/day and divides those totals. Its source ignores cross-filter selections to keep the matrix available while other widgets filter.

`money_events` contains the latest ledger transition for each kind/request. Issued refunds and captures include COMPLETED and labelled SIMULATED amounts; pending/failed requests remain visible in receipts but do not enter issued totals. Net revenue is captures minus issued refunds. Money charts use receipt dates, which may differ from the scheduled class week. Revenue kept measures recovery interventions: repeated disruptions can count the same booking again. The report uses this workspace's ledger.

## Gemini proxy and configuration

- `GEMINI_API_KEY`: server-only key for the workspace LLM proxy.
- `GEMINI_MODELS`: model allowlist/fallback chain; defaults to `gemini-flash-lite-latest,gemini-3.5-flash,gemini-flash-latest`.
- `NEXT_PUBLIC_AG_STUDIO_LICENSE`: optional public Studio licence key; without it, expect trial warnings/watermark.

`POST /api/workspaces/[id]/llm` validates workspace and request. Harness turns identify themselves with `X-Rebook-Studio: harness`; the body is capped at 262,144 bytes and accepts only known agents and their local Studio tool names. Live per-widget schemas/instructions sit beneath a server-owned workspace policy. Unknown tools, provider-hosted tools and cross-agent tool rosters are rejected. Older clients retain the narrow server-defined tool contract and 65,536-byte body cap.

The fixed provider URL is Google's OpenAI-compatible Chat Completions endpoint. Non-streaming output is capped at 4,096 tokens, with a 12-second per-model deadline and 25-second overall budget. Failures fall back across configured models and expose a friendly 503. The shared process-local limiter defaults to 10 calls/minute for each client and workspace, 30/minute globally, 1,200/day and 4 concurrent calls; each completion in a delegation loop counts. Larger deployments need shared limit storage. Credentials never reach the browser.

The adapter retains Google's complete `extra_content`, including thought signatures, on call items and in a call-ID sidecar. It regroups Studio's interleaved call/result pairs into Chat Completions assistant turns. Chat history is in memory; only report state is persisted.

## Verification and API limits

No dependencies were added and no external requests were made for implementation or tests. Tests mock provider transport. Coverage includes structural report mappings/layouts, heatmap aggregation, empty KPI values, formatters, tool cards, delegation configuration, child completion-tool acceptance and adapter schema forwarding, alongside workspace/ledger/proxy tests.

APIs were checked against supplied offline 3.0.0 guides and installed declarations/source. The custom `formatShape` uses the public `defineAiCommand(...).shape` bridge because Studio exports no standalone shape-builder constructor. This is the least conventional integration point. Browser checks of forms, exports, cross-filter repaint and the 1526×674 / 1280×720 layouts, plus live Gemini chart/filter delegation, remain necessary if this environment cannot run the application. Automated layout-bound checks do not substitute for visual QA.

The 3.0.0 `overrides` generic resolves to `never` when a registry contains custom widget types. Export buttons therefore use the public returned widget definitions' `toolbar` property, retaining the built-in action handlers. Public icon names are `csv` and `download`; internal names such as `widgetToolbarExport` are not accepted by that property.

C4 verification: `npx vitest run --pool=threads --maxWorkers=2` initially passed 222/223 tests; an existing workspace-creation API test exceeded its 5-second timeout. Repeating with `--testTimeout=15000` passed all 224 tests (including the subsequently added widget/export configuration test). `npx tsc --noEmit`, `npx eslint` and `git diff --check` passed. The single `npx next build` attempt, with a 1,536 MB Node heap cap, two Rust threads and telemetry disabled, compiled successfully in 45 seconds, then failed starting the TypeScript worker with `spawn EPERM`. There was no second build attempt. Visual/browser, actual file-download and live Gemini verification remain outstanding; the task prohibited external network calls.
