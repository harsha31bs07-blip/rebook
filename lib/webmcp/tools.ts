import type { PublicPlan } from "../client/api";
import type { State } from "../domain/types";
import { localParts } from "../domain/time";
import type { ToolInput, ToolSchema, WebMcpTool } from "./bridge";
import type { ChoiceProposal } from "../choices/assistant";

const empty: ToolSchema = { type: "object", properties: {}, additionalProperties: false };
const string = { type: "string" };
export function choiceTools({ canChoose, busy, ask }: { canChoose: boolean; busy: boolean; ask(message: string, signal: AbortSignal): Promise<ChoiceProposal> }): WebMcpTool[] {
  return canChoose && !busy ? [{ name: "ask_rebook_assistant",
    description: "Propose one booking choice from the customer's preferences and show it on this private page. Does not change bookings or issue refunds. A human must click Confirm.",
    inputSchema: { ...empty, properties: { message: { ...string, minLength: 1, maxLength: 300 } }, required: ["message"] },
    annotations: { readOnlyHint: true }, execute: (input, { signal }) => ask(textArgument(input, "message", 300, true)!, signal),
  }] : [];
}
export function textArgument(input: ToolInput, key: string, max: number, required = false): string | undefined {
  const value = input[key];
  if (value === undefined && !required) return;
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${key}.`);
  return value.trim();
}
export function planSummary(plan: PublicPlan, currency: string) {
  return { planId: plan.id, status: plan.status, currency, ...plan.totals, warnings: plan.warnings };
}
export function localClass(start: string, end: string, timezone: string) {
  const clock = (instant: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant));
  return { day: localParts(start, timezone).dateKey, weekday: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(new Date(start)), startTime: clock(start), endTime: clock(end), timezone };
}

export function ownerTools({ state, plans, currentPlan, busy, report, requestApproval }: {
  state: State; plans: PublicPlan[]; currentPlan?: PublicPlan; busy: boolean;
  report(text: string, signal: AbortSignal): Promise<unknown>;
  requestApproval(planId: string, signal: AbortSignal): Promise<unknown>;
}): WebMcpTool[] {
  const planIds = plans.map((plan) => plan.id);
  const tools: WebMcpTool[] = [{
    name: "get_week_schedule", description: "Read this studio's week: local dates and times, instructors, rooms, booked seats and capacity. Does not modify the schedule.",
    inputSchema: empty, annotations: { readOnlyHint: true },
    execute: () => state.sessions.map((session) => ({ sessionId: session.id, title: session.title, classType: session.classType,
      ...localClass(session.start, session.end, state.studio.timezone),
      instructor: state.instructors.find((item) => item.id === session.instructorId)?.name,
      room: state.rooms.find((item) => item.id === session.roomId)?.name, capacity: session.capacity,
      booked: state.bookings.filter((booking) => booking.sessionId === session.id && ["confirmed", "moved"].includes(booking.status)).length })),
  }, {
    name: "get_plan_summary", description: "Read a recovery plan's kept, moved and refunded booking counts and money amounts. Omit planId for the visible plan.",
    inputSchema: { ...empty, properties: { planId: string } }, annotations: { readOnlyHint: true },
    execute: (input) => {
      const planId = textArgument(input, "planId", 100);
      const plan = planId ? plans.find((item) => item.id === planId) : currentPlan;
      if (!plan) throw new Error("No matching plan. Prepare a disruption preview first.");
      return planSummary(plan, state.studio.currency);
    },
  }];
  if (!busy) tools.push({
    name: "report_disruption", description: "Interpret a disruption and prepare a recovery preview on the owner's timeline. Returns planId, kept/moved/refunded counts and money amounts. Does not apply changes or issue refunds; the owner must review and click Approve and refund.",
    inputSchema: { ...empty, properties: { text: { ...string, minLength: 1, maxLength: 500 } }, required: ["text"] },
    execute: (input, { signal }) => report(textArgument(input, "text", 500, true)!, signal),
  });
  if (!busy && planIds.length && plans.some((plan) => plan.status === "proposed")) tools.push({
    name: "request_approval", description: "Show a proposed plan and highlight Approve and refund for the owner to review. This only requests human approval. It NEVER executes the plan or moves money.",
    inputSchema: { ...empty, properties: { planId: { ...string, enum: plans.filter((plan) => plan.status === "proposed").map((plan) => plan.id) } }, required: ["planId"] },
    execute: (input, { signal }) => requestApproval(textArgument(input, "planId", 100, true)!, signal),
  });
  return tools;
}

export type BookingClass = { id: string; title: string; classType: string; start: string; end: string; instructor: string; room: string; seatsLeft: number; price: string; capacity: number };
export function bookingTools<T extends BookingClass>({ sessions, timezone, locked, select }: {
  sessions: T[]; timezone: string; locked: boolean;
  select(session: T, customer?: { name?: string; email?: string }): void;
}): WebMcpTool[] {
  const tools: WebMcpTool[] = [{
    name: "list_classes", description: "Read available classes, prices and seats. Filter day by studio-local YYYY-MM-DD or weekday name, and classType (yoga, pilates, spin, dance, hiit, barre).",
    inputSchema: { ...empty, properties: { day: string, classType: string } }, annotations: { readOnlyHint: true },
    execute: (input) => {
      const day = textArgument(input, "day", 20)?.toLowerCase();
      const type = textArgument(input, "classType", 30)?.toLowerCase();
      return sessions.map((session) => ({ sessionId: session.id, title: session.title, classType: session.classType, instructor: session.instructor, room: session.room,
        ...localClass(session.start, session.end, timezone), seatsLeft: session.seatsLeft, capacity: session.capacity, price: session.price, currency: "USD" }))
        .filter((session) => (!day || session.day === day || session.weekday.toLowerCase() === day) && (!type || session.classType === type));
    },
  }];
  const available = sessions.filter((session) => session.seatsLeft > 0);
  if (!locked && available.length) tools.push({
    name: "start_booking", description: "Select a class and optionally prefill name and email in the visible checkout card. This does not reserve, book or pay. A human must approve payment through PayPal or the hosted card checkout; never provide payment credentials to an assistant.",
    inputSchema: { ...empty, properties: { sessionId: { ...string, enum: available.map((session) => session.id) }, name: { ...string, maxLength: 100 }, email: { ...string, format: "email", maxLength: 254 } }, required: ["sessionId"] },
    execute: (input) => {
      const session = available.find((item) => item.id === textArgument(input, "sessionId", 100, true));
      if (!session) throw new Error("Class unavailable. List classes again.");
      const name = textArgument(input, "name", 100);
      const email = textArgument(input, "email", 254);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Invalid email.");
      select(session, { name, email });
      return { sessionId: session.id, status: "awaiting_human_payment", message: "Checkout prepared. A human must approve PayPal or card payment." };
    },
  });
  return tools;
}
