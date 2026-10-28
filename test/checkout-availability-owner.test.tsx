import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";

const grid = vi.hoisted(() => ({ rows: [] as { reason: string }[] }));
vi.mock("ag-grid-community", () => ({ AllCommunityModule: {}, ModuleRegistry: { registerModules: vi.fn() }, enableDevValidations: vi.fn(), themeQuartz: { withParams: () => ({}) } }));
vi.mock("ag-grid-react", () => ({ AgGridReact: ({ rowData }: { rowData: typeof grid.rows }) => { grid.rows = rowData; return null; } }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/client/scheduler-mapping", () => import("../lib/client/scheduler-mapping"));
vi.mock("@/lib/domain/time", () => import("../lib/domain/time"));
import BookingGrid from "../components/console/booking-grid";
import { RefundResults } from "../components/console/plan-panel";

it("shows availability not given only for explicitly unknown customers in booking reasons and refund results", () => {
  const state = seedStudio(), plan = replan(state, demoDisruption);
  const actions = plan.bookingActions.slice(0, 3);
  const customers = actions.map((action) => state.customers.find((customer) => customer.id === action.customerId)!);
  customers[0].prefs.availabilityKnown = false; customers[1].prefs.availabilityKnown = true;
  renderToStaticMarkup(<BookingGrid plan={{ ...plan, bookingActions: actions }} state={state} />);
  expect(grid.rows.map((row) => row.reason.includes("availability not given"))).toEqual([true, false, false]);
  expect(grid.rows[0].reason).toContain(actions[0].reason);
  const results = actions.map((action) => ({ bookingId: action.bookingId, status: "COMPLETED" }));
  const html = renderToStaticMarkup(<RefundResults results={results} state={state} />);
  expect(html.match(/availability not given/g)).toHaveLength(1);
});
