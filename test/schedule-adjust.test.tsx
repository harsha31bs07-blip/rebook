import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { checkAdjustment, adjustPlan } from "../lib/solver/adjust";
import { mapSchedule, resourceUtilisation } from "../lib/client/scheduler-mapping";
import { activateConstraint } from "../lib/solver/constraints";
import { replan } from "../lib/solver/replan";
import { ScheduleBoundary, ScheduleFallback } from "../components/console/schedule-boundary";
import { adjustmentFixture, disruption } from "./adjust-fixture";

const state = adjustmentFixture();
const plan = replan(state, disruption, { now: "2026-11-09T00:00:00Z" });
it("drag validator accepts a free skilled instructor and rejects skill, overlap, unavailability, hours and week boundaries", () => {
  expect(checkAdjustment(state, plan, { sessionId: "s1", start: "2026-11-10T10:00:00Z", instructorId: "i1" }).valid).toBe(true);
  expect(checkAdjustment(state, plan, { sessionId: "s1", start: "2026-11-09T12:15:00Z" })).toMatchObject({ valid: false, message: "Alex already teaches at 12:15 PM." });
  for (const input of [
    { sessionId: "s1", start: "2026-11-10T10:00:00Z", instructorId: "i3" },
    { sessionId: "s1", start: "2026-11-09T10:00:00Z", instructorId: "i1" },
    { sessionId: "s1", start: "2026-11-09T06:00:00Z" },
    { sessionId: "s1", start: "2026-11-16T10:00:00Z" },
    { sessionId: "s2", start: "2026-11-10T10:00:00Z" },
  ]) expect(checkAdjustment(state, plan, input).valid).toBe(false);
  const unavailable = structuredClone(state);
  unavailable.instructors[1].unavailability = [{ from: "2026-11-10T10:00:00Z", to: "2026-11-10T11:00:00Z" }];
  expect(checkAdjustment(unavailable, plan, { sessionId: "s1", start: "2026-11-10T10:00:00Z" }).message).toContain("unavailable");
});

it("maps only recovery blocks as draggable, shows overrides and uses replacement capacity", () => {
  const adjusted = adjustPlan(state, plan, { sessionId: "s1", start: "2026-11-09T10:00:00Z", roomId: "r2" });
  for (const mode of ["instructors", "rooms"] as const) {
    const mapped = mapSchedule(state, mode, adjusted);
    expect(mapped.events.filter((item) => item.draggable).map((item) => item.id)).toEqual(["s1-new"]);
    expect(mapped.details["s1-new"]).toMatchObject({ badge: "Adjusted by you", occupancy: "1/1 booked" });
    expect(mapped.events.find((item) => item.id === "s1-new")?.resourceId).toBe(mode === "rooms" ? "r2" : "i2");
  }
});

it("maps intrinsic and active constraints without a selected plan in both row modes", () => {
  const constrained = activateConstraint(state, disruption);
  constrained.instructors[1].unavailability = [{ from: "2026-11-10T10:00:00Z", to: "2026-11-10T11:00:00Z" }];
  for (const mode of ["instructors", "rooms"] as const) {
    const mapped = mapSchedule(constrained, mode);
    expect(mapped.resourceTimeRanges.length).toBeGreaterThan(1);
    expect(mapped.resourceTimeRanges.every((item) => item.cls === "disruption-range")).toBe(true);
    expect(mapped.resourceTimeRanges.map((item) => item.name)).toContain("Maya unavailable");
    expect(mapped.resourceTimeRanges.map((item) => item.name)).toContain("Alex unavailable");
  }
});

it("summarises proposed load without counting ghosts; room capacity is opening hours", () => {
  expect(resourceUtilisation(state, "instructors", "i1", plan)[0]).toMatchObject({ booked: 0, capacity: 3, unit: "classes" });
  expect(resourceUtilisation(state, "instructors", "i2", plan)[0]).toMatchObject({ booked: 2, capacity: 3 });
  expect(resourceUtilisation(state, "rooms", "r1", plan)[0]).toMatchObject({ booked: 2, capacity: 14, unit: "hours" });
});

it("renders the boundary's failed state as an accessible week and recovery list with move buttons", () => {
  const fallback = <ScheduleFallback state={state} plan={plan} onMove={() => {}} />;
  const boundary = new ScheduleBoundary({ children: <div>Scheduler</div>, fallback });
  boundary.state = ScheduleBoundary.getDerivedStateFromError();
  const html = renderToStaticMarkup(boundary.render());
  expect(html).toContain("Accessible week schedule"); expect(html).toContain("interactive timeline is unavailable");
  expect(html).toContain("Yoga · Recovery"); expect(html).toContain("Yoga · Original"); expect(html).toContain("Later Yoga");
  expect(html).toContain("Move Yoga to…"); expect(html).toContain("Maya unavailable");
  const working = new ScheduleBoundary({ children: <div>Scheduler</div>, fallback });
  expect(renderToStaticMarkup(working.render())).toBe("<div>Scheduler</div>");
});
