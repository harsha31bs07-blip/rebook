import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { PlanDetails, PublicPlan } from "../lib/client/api";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import CoverPay from "../components/console/cover-pay";
import type { OwnerCover } from "../lib/recovery/cover-pay";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/client/scheduler-mapping", () => import("../lib/client/scheduler-mapping"));
vi.mock("@/lib/domain/time", () => import("../lib/domain/time"));
import PlanPanel, { ApprovalDialog } from "../components/console/plan-panel";

const state = seedStudio();
const plan: PublicPlan = { ...replan(state, demoDisruption), id: "correction", workspaceId: "workspace", status: "proposed", createdAt: new Date().toISOString(), results: [], correctionOf: "earlier-plan" };
const details: PlanDetails = { plan, sessions: state.sessions, messages: [], explanation: { headline: "Your schedule correction is ready", source: "template", bullets: [] } };

it("labels the correction review and approval without asking for refunds or another cover", () => {
  const html = renderToStaticMarkup(<PlanPanel details={details} plan={plan} state={state} busy={false} results={[]} onApprove={vi.fn()} onDiscard={vi.fn()} onMessages={vi.fn()} />);
  expect(html).toContain("This undoes the recovery you approved for this disruption.");
  expect(html).toContain(">Approve correction</button>");
  expect(html).not.toContain("Approve and refund");
  expect(html).not.toContain("Confirm substitute arrangements");
  const dialog = renderToStaticMarkup(<ApprovalDialog correction unconfirmed={[]} busy={false} onApprove={vi.fn()} onClose={vi.fn()} />);
  expect(dialog).toContain("Confirm correction");
  expect(dialog).toContain("no new refunds are issued");
  expect(dialog).not.toContain("starts sandbox refunds");
});

it("offers a secondary withdrawal action on an eligible approved plan and shows a corrected record", () => {
  const approved = { ...plan, correctionOf: undefined, status: "executed" as const };
  const props = { details, plan: approved, state, busy: false, results: [], onApprove: vi.fn(), onDiscard: vi.fn(), onMessages: vi.fn() };
  const html = renderToStaticMarkup(<PlanPanel {...props} onWithdraw={vi.fn()} />);
  expect(html).toContain('class="full-width">The disruption is over — restore the schedule</button>');
  const corrected = renderToStaticMarkup(<PlanPanel {...props} plan={{ ...approved, correctedBy: "correction-id" }} />);
  expect(corrected).toContain('role="status">Corrected by plan correction-id');
  expect(corrected).not.toContain("The disruption is over — restore the schedule");
});

it("keeps settled cover pay visible and removes the payout action after withdrawal", () => {
  const cover: OwnerCover = { planId: "earlier-plan", sessionId: "yoga", instructor: "Alex Rivera", original: "Maya Chen", class: "Yoga Flow", when: "Monday",
    status: "withdrawn", current: false, respondedBy: "instructor", fee: "35.00", path: "/i/token", payee: true,
    payout: { status: "SUCCESS", amount: "35.00", itemId: "PAID", error: undefined } };
  const html = renderToStaticMarkup(<CoverPay workspaceId="workspace" covers={[cover]} onUpdated={vi.fn()} />);
  expect(html).toContain("The existing payout stays recorded.");
  expect(html).toContain("Paid");
  expect(html).not.toContain("<button");
});
