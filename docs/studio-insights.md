# Studio insights

Open `/w/<workspace-id>/dashboard` using Dashboard in the schedule header. The two initial report pages are **Week overview** (seven widgets) and **Disruptions** (four widgets). Edit report exposes Studio's builder, including Recovery impact and Refund receipts under Rebook. Ask Recovery analyst opens Studio's chat panel; the five built-in agents are also registered.

Report state, including custom widget settings, filters and layout, is stored in `localStorage` under `rebook:studio:<workspace-id>`. Restore default report replaces that workspace's saved layout. The page uses a fixed viewport-height flex layout; Studio and receipt lists scroll inside their own containers.

## Configuration

- `GEMINI_API_KEY`: server-only key used by the workspace LLM proxy.
- `GEMINI_MODELS`: ordered allowlist/fallback chain; defaults to `gemini-flash-lite-latest,gemini-3.5-flash,gemini-flash-latest`. A client-selected model is used first only if present in this allowlist.
- `NEXT_PUBLIC_AG_STUDIO_LICENSE`: optional public Studio licence key supplied to `AgStudioProvider`. Without a key, expect trial warnings/watermark.

No dependencies were added. No external requests were made during implementation or verification. Gemini was tested with mocked `fetch`; live Gemini and PayPal verification remain for the orchestrator.

## Data semantics

`GET /api/workspaces/[id]/insights` requires a ready workspace. It returns eight flat tables: sessions, bookings, customers, instructors, rooms, money_events, disruptions and booking_actions, plus studio metadata and explanatory notes. Customer emails are omitted. Money is numeric USD, converted through the domain cents helper. Local date/time and window labels use the same studio-timezone helpers as the console.

Cancelled sessions are recovered from applied plans' persisted basis so their bookings still join to a session. Each disruption is one plan, including explicit proposed/applied status and cover descriptions. Revenue booked is gross booking value. Overview recovery KPIs use applied plans only; saved rate is `(kept + moved) / affected bookings`. Recovery impact shows the selected plan, defaulting to the newest, and labels proposed figures as forecasts.

money_events contains the latest ledger transition for each kind/request, avoiding double-counting REQUESTED -> PENDING -> COMPLETED. Issued refunds include COMPLETED and explicitly labelled SIMULATED amounts; pending/failed amounts remain visible in receipts but are excluded from issued totals. Revenue kept measures recovery interventions: repeat disruptions can count the same booking again. Optional PayPal transaction search was not added; the report uses this workspace's own ledger.

## Gemini proxy and adapter

`POST /api/workspaces/[id]/llm` validates workspace and Chat Completions request shape. It calls only Google's OpenAI-compatible **Chat Completions** endpoint, with Bearer authentication. It forces non-streaming output and a 4,096-token cap, applies a 12-second per-model deadline within a 25-second total budget, falls back across configured models, and returns a friendly 503 without upstream error bodies when unavailable.

The proxy limits each workspace to 30 LLM turns per 10 minutes. Buckets are process-local; deployments with multiple application instances should use a shared limiter. Turns include the tool-loop completions, rather than only user messages. Request bodies are capped at 1,048,576 characters.

The client adapter translates Studio instructions/history/tools/tool choice/structured output to Chat Completions, and emits `TEXT_MESSAGE_CHUNK` and `TOOL_CALL_CHUNK` events plus an `AgLlmResponse`. Google's entire `extra_content` object, including `google.thought_signature`, is preserved on returned call items and in an adapter-scoped sidecar keyed by call ID. This survives Studio's conversation-item cloning between runs. Studio's interleaved call/result pairs are regrouped into each original assistant turn, followed by the matching tool messages. Chat history is in memory; only the report is persisted.

Recovery analyst has `get_disruptions` and `get_refund_receipts` custom tools (optional plan ID and receipt status filters), plus Studio's schema/query/page/widget tools. Its instructions require numeric claims to cite tool data and distinguish simulations, forecasts and pending refunds. It can build/update a grouped bar chart; the built-in agents remain available for other report work.

## AG Studio API inventory

All APIs were checked against the supplied offline AG Studio 3.0.0 documentation and/or installed 3.0.0 declarations and implementation.

- React: `AgStudio`, `AgStudioProvider` (`modules`, `licenseKey`), and React's `createWidgets` helper. `AgStudio` props: `ref`, `style`, `data`, `theme`, `layout`, `mode`, `widgets`, `initialState`, `ai`, `onStateUpdated`, `onErrorRaised`.
- Studio state/API: `api.getState()`, `api.setState(fullState)`, `AgReportState`/pages/`selectedPageId`, `panels` including `ai.collapsed`, page `widgets`, `widgetLayout`, `sort`, and page `filter.widget`.
- Data model: `AgDataSourcesDefinition`, synchronous `sources[].data`, explicit `fields` (`id`, `name`, `format`, `hide`), `relationships` (`source`, `target`, `type: many-to-one`), and `expressions` with aggregate field references, `divide`, `isMeasure`, and `percentageFormat`. Built-in formats: `textFormat`, `booleanFormat`, `integerFormat`, `currencyFormat`, `percentageFormat`.
- Built-in report widgets: `value`, `bar-chart-grouped`, `grid`; mappings `value`, `categoryKey`, `valueKey`, `cols`; aggregations `sum`/`countd`; `format.title`; widget-layout track coordinates.
- Custom widgets: React `AgWidgetDefinition`, `AgWidgetParams`, `AgWidgetsConfig`, custom registry, `dataMapping` fieldset definition and hydrated fields (`fieldId`, `key`), `formatShape`, `form`, `defaultState`, `defaultSize`, `minSize`, `ai.description`, and menu groups.
- Custom widget data: `widgetApi.getData({ fields })`, `response.results.rows`, `widgetApi.setDisplayState('loading', { prominent: false })`, `'displayed'`, and `'incompleteDataMapping'`. Widgets use this API exclusively and make no side fetches.
- Widget forms: `params.createDefaults({ dataMappingItems })`, `params.createWidgetAppearanceSection()`, tab items, section items, and `textfield` input bound to `format.style.planId`.
- Theme: `studioTheme.withParams()`. Shared params `fontFamily`, `fontSize`, `accentColor`, `textColor`, `foregroundColor`, `subtleTextColor`, `borderColor`, `backgroundColor`; wrapper params `studioWrapperBorder`, `studioWrapperBorderRadius`, `studioWrapperSpacing`; canvas params `studioCanvasBackgroundColor`, `studioCanvasBorder`, `studioCanvasShadow`, `studioCanvasPadding`, `studioCanvasRowHeight`; widget params `studioWidgetBackgroundColor`, `studioWidgetBorder`, `studioWidgetBorderRadius`, `studioWidgetPadding`, `studioWidgetTitleFontSize`, `studioWidgetTitleFontWeight`, `studioWidgetTitleTextColor`; `studioPanelContainerBorderRadius`; grid params `gridFontSize`, `gridHeaderFontSize`, `gridHeaderTextColor`, `gridHeaderBackgroundColor`, `gridRowHeight`; chart params `chartFontFamily`, `chartTextColor`, `chartSubtleTextColor`, `chartGridLineColor`, `chartPaletteFills1Color`, `chartPaletteStrokes1Color`, `chartPaletteFills2Color`, `chartPaletteStrokes2Color`.
- AI setup: `AgStudioAiModule`, `createAiHarness(api, builder)`, builder `builtIn`, `directLlmRunner`, agent `id`/`name`/`description`/`schema`/`instructions`/`tools`/`maxTurns`, harness `agents`/`primary`/`promptStarters`.
- Tools/shapes: `api.defineAiTool` with `params`, `execute`, `ctx.success`; `api.defineAiCommand(factory).shape` for the custom format schema; shape builder `object`, `string`, `number`, `boolean`, `enum`, `undefined`, `optional`.
- Built-in toolkit: `api.getAiTools()`, `viewSchema`, `executeQuery`, `viewPage`, `viewWidget`, `addWidget`, `positionWidget`, `addWidgetFilter`, `removeWidgetFilter`, and `configureWidget({ widgetId, widgetType })`.
- Adapter: `AgLlmAdapter.executeTurn`, `AgLlmRequest` (`input`, `instructions`, `tools`, `toolChoice`, `responseFormat`, `model`), `options.signal`, response handler `stream`/`complete`, `AgAiEvent` chunk events, conversation messages/function calls/function outputs, `AgLlmResponse` completion/incomplete status and `incompleteDetails`.

## Verification and remaining checks

The supplied folder has `theming.md` but no separate `studio-theme.md`; theme parameter names were additionally checked against installed declarations. The format-shape implementation uses the public `defineAiCommand(...).shape` bridge because Studio does not export a standalone shape-builder constructor. This is confirmed by installed source, but is the least conventional integration point to exercise in a browser.

TypeScript, ESLint and all 143 Vitest tests pass. Tests cover endpoint shape/workspace isolation/referential integrity/cancelled sessions/ledger deduplication, adapter translation and signature round trips (including Studio's interleaved pairs and parallel calls), and proxy fallback/deadlines/rate limiting/error handling.

`next build` compiled the production bundle, then failed starting its TypeScript worker with `spawn EPERM`. `next dev --hostname 127.0.0.1` was blocked by the same child-process restriction. Browser QA is therefore outstanding: check 1526×674, widget data/display/forms, saved-state restore, chat and chart creation, and Monday-to-Sunday schedule headers. No AG Studio runtime API uncertainty remains from declarations; browser behavior and live Gemini tool execution are unverified.
