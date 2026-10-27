# Owner-controlled recovery on Bryntum Scheduler

The owner reviews the original schedule as ghosts alongside highlighted recovery placements. In preview, drag only a recovery block, including between instructor rows or room rows. Week cards move between day/resource cells while keeping the class's studio-local clock time; Day view uses quarter-hour positioning. Each recovery card exposes a **Move** button on hover or keyboard focus (always visible on touch devices). Focus a card and press Enter or Space, or use a **Move...** link in the plan's changed-session list, for the same keyboard dialog. Every adjustment recomputes customer booking actions and totals before approval; **Undo last adjustment** restores the prior placement through the same checks.

## Bryntum features used

| Feature | Config | Where | Why |
| --- | --- | --- | --- |
| EventDrag | `eventDragFeature: { validatorFn, constrainDragToTimeline: true, constrainDragToResource: false, copyKey: "", showExactDropPosition: true }` | `components/console/schedule.tsx` | Only proposed recovery event models are draggable; instructor and room moves share the same preference-aware server validation. |
| Date constraints and snapping | `getDateConstraints`, `snap: true`, 15-minute `timeResolution` | `schedule.tsx`, `scheduler-mapping.ts` | Keep drag placements within the studio week and align to quarter hours. `recoveryDropStart` converts interaction wall dates back into studio-zone instants, preserving the clock for Week cells. |
| Async drop finalization | `onBeforeEventDropFinalize`, `context.async`, `context.dropData.events`, `context.finalize` | `schedule.tsx` | Wait for the adjust route, accept valid drops and snap rejected drops back with a reason. Week drops preserve the original clock in both the server request and Bryntum's final event data. |
| Drag tooltip | `EventDrag.validatorFn` returns `{ valid, message }`, `showTooltip: true` | `schedule.tsx`, `lib/solver/adjust.ts` | Fast checks explain skills, collisions, opening hours and persisted constraints before dropping. A rejected server drop also displays a reason tooltip. |
| Event tooltip | `eventTooltipFeature.template` | `schedule.tsx` | Show exact time, room, occupancy and recovery status; text is HTML encoded. |
| Resource time ranges | `resourceTimeRangesFeature: true`, `resourceTimeRanges` | `lib/client/scheduler-mapping.ts` | Hatch instructor unavailability and active resource constraints even without a current plan. Cross-view bands identify the unavailable resource on its associated rows. |
| Time ranges | `timeRangesFeature`, `timeRanges` | `scheduler-mapping.ts` | Shade studio closures across all resource rows. |
| Resource column | `columns[].renderer`, `resourceUtilisation` | `schedule.tsx`, `scheduler-mapping.ts` | Daily booked/capacity includes proposed placements: classes versus daily instructor limit, or room hours versus opening hours. |
| Dependencies | `dependenciesFeature`, `dependencies` | `schedule.tsx`, `scheduler-mapping.ts` | Link originals to their time moves; arrows are hidden when endpoints are outside the visible axis. |
| Event rendering | `eventRenderer`, DOM configs, `draggable`, `resizable: false` | `schedule.tsx`, `scheduler-mapping.ts` | Separate originals, recovery and cancelled classes; show the **Adjusted by you** badge and accessible event labels. |
| Keyboard selection | React capture handlers, native rendered Move button, `onEventKeyDown` | `schedule.tsx`, `move-to-popover.tsx`, `plan-panel.tsx` | Enter/Space on a focused recovery card or its Move control opens a native modal with day, time, instructor and room selects, trapped focus, Escape dismissal and focus restoration. Capture handlers run before Scheduler navigation in both views. |
| Timezone and views | `timeZone`, UTC initial axis bounds, wall dates for runtime interactions, `viewPreset`, `workingTime`, instructor/room resources | `schedule.tsx` | One studio-local Monday–Sunday week and precise day view independent of the viewer's timezone. Initial axis instants convert with the project; runtime wall dates avoid a second timezone conversion. |
| Trial resilience | React `ScheduleBoundary` surrounding the dynamic Scheduler | `owner-console.tsx`, `schedule-boundary.tsx` | A rendering or trial failure displays an accessible week and recovery list with the same move controls. |

`POST /api/workspaces/[id]/plans/[planId]/adjust` takes `{ sessionId, start, instructorId?, roomId?, version }`, or `{ undo: true, version }`. Versions begin at 1 (omission is accepted only as version 1 for existing clients). The server holds the workspace lock while comparing the version, deriving actions and totals, and validating the whole schedule. Invalid placements return 422 with a reason; stale versions return 409. Approval sends the displayed version and compares it under the same lock before applying the persisted adjusted plan and starting refunds. Adjusting a preview never changes the live schedule or starts refunds.

## Verified (2026-10-27)

- Offline tests cover adjustment preferences, capacity, constraints, undo, stale versions and approval; mapping and drag pre-checks; keyboard Move controls and the fallback render.
- The Monday scenario remains 9 kept / 16 moved / 6 refunded, with $577.00 kept and $135.00 refunds.
