import { z } from "zod";
import type { Session, State } from "../domain/types";
import { isActiveBooking } from "../solver/score";
import { feasibilityErrors } from "../solver/validate";
import { PayPalError } from "../paypal/client";
import { createPayout, getPayout } from "../paypal/payouts";
import { getRepository, StoreError, withWorkspaceLock, type CoverLink, type CoverPayout, type Repository, type StoredPlan } from "../store";
import { planCovers } from "./covers";
import { coverAttendees, coverFee, payRule, PayRuleUpdateSchema } from "./pay-rules";

export { COVER_FEE } from "./pay-rules";
export const CoverTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const ACTIVE = ["REQUESTED", "PENDING", "UNCLAIMED", "ONHOLD"];
const ITEM_STATUSES = ["SUCCESS", "FAILED", "PENDING", "UNCLAIMED", "RETURNED", "ONHOLD", "BLOCKED", "REFUNDED", "REVERSED"] as const;

/** After approval, each substitute gets a private accept/decline link; an owner-confirmed cover starts accepted. */
export function createCoverLinks(plan: StoredPlan, basis: State, repository: Repository): void {
  const { state } = repository.requireWorkspace(plan.workspaceId);
  for (const cover of planCovers(plan, basis)) {
    const confirmed = plan.coverConfirmations?.find((item) => item.sessionId === cover.sessionId && item.instructorId === cover.instructorId);
    repository.createCoverLink({ workspaceId: plan.workspaceId, planId: plan.id, sessionId: cover.sessionId, instructorId: cover.instructorId,
      status: confirmed ? "accepted" : "asked", ...(confirmed ? { respondedAt: confirmed.confirmedAt, respondedBy: "owner" as const } : {}),
      fee: coverFee(payRule(state, cover.instructorId), coverAttendees(state, cover.sessionId)) });
  }
}

function details(link: CoverLink, repository: Repository) {
  const { state } = repository.requireWorkspace(link.workspaceId, true);
  const plan = repository.getPlan(link.workspaceId, link.planId);
  const session = state.sessions.find((item) => item.id === link.sessionId);
  const change = plan?.sessionChanges.find((item) => item.sessionId === link.sessionId);
  const name = (id?: string) => state.instructors.find((item) => item.id === id)?.name ?? "Studio team";
  const payout = repository.listCoverPayouts(link.workspaceId).find((item) => item.planId === link.planId && item.sessionId === link.sessionId && item.instructorId === link.instructorId);
  return { state, session, instructor: name(link.instructorId), original: name(change?.before.instructorId), current: !link.withdrawnBy && session?.instructorId === link.instructorId,
    payout: payout && { status: payout.status, amount: payout.amount, itemId: payout.itemId, error: payout.error } };
}
const payoutLocks = (payout?: { status: string }) => !!payout && ACTIVE.concat("SUCCESS").includes(payout.status);
const editablePay = (payout?: { status: string }) => !payout || payout.status === "FAILED";
function feeDetails(link: CoverLink, state: State, session: Session | undefined, payout?: { status: string; amount: string }) {
  const rule = payRule(state, link.instructorId), attendees = coverAttendees(state, link.sessionId);
  return { rule, attendees, fee: editablePay(payout) ? coverFee(rule, attendees) : payout!.amount,
    estimate: editablePay(payout) && rule.perAttendee !== undefined && !!session && Date.parse(session.start) > Date.now() };
}

/** Public instructor view: the class, the fee and the payout. No customer data. */
export function coverView(token: string, repository = getRepository()) {
  const link = repository.coverLinkByToken(CoverTokenSchema.parse(token));
  if (!link) throw new StoreError(404, "This link is no longer available. Rebook's demo runs on a free server that resets when it restarts, so demo links can end early. Nothing was charged: payments run in PayPal's sandbox.");
  void refreshCoverPayouts(link.workspaceId, repository).catch(() => {});
  return viewOf(link, repository);
}
function viewOf(link: CoverLink, repository: Repository) {
  const { state, session, instructor, original, payout, current } = details(link, repository);
  if (!session) throw new StoreError(410, "This class is no longer on the schedule.");
  return { studio: { name: state.studio.name, timezone: state.studio.timezone }, status: link.withdrawnBy ? "withdrawn" as const : current ? link.status : "replaced" as const,
    ...feeDetails(link, state, session, payout), instructor, original,
    class: { title: session.title, start: session.start, end: session.end, room: state.rooms.find((room) => room.id === session.roomId)?.name ?? "Studio" },
    payout, canRespond: current && !payoutLocks(payout) && Date.parse(session.start) > Date.now() };
}
export type CoverView = ReturnType<typeof viewOf>;

export async function respondToCover(token: string, action: "accept" | "decline", repository = getRepository()) {
  const initial = repository.coverLinkByToken(CoverTokenSchema.parse(token));
  if (!initial) throw new StoreError(404, "This link is no longer available. Rebook's demo runs on a free server that resets when it restarts, so demo links can end early. Nothing was charged: payments run in PayPal's sandbox.");
  await withWorkspaceLock(repository, initial.workspaceId, () => repository.transaction(() => {
    const link = repository.coverLinkByToken(token)!;
    const view = viewOf(link, repository);
    if (!view.canRespond) throw new StoreError(409, view.status === "withdrawn" ? "This class went back to its regular instructor." : view.status === "replaced" ? "A later schedule change gave this class to someone else." : view.payout ? "This cover has already been paid." : "This class has already started.");
    const status = action === "accept" ? "accepted" : "declined";
    if (link.status !== status) repository.saveCoverLink({ ...link, status, respondedAt: new Date().toISOString(), respondedBy: "instructor" });
  }));
  return coverView(token, repository);
}

/**
 * The next instructor to ask after a decline: qualified, free at the class's time, within their daily limit, not the
 * disrupted resource, never asked before for this class, and acceptable to every customer still booked.
 */
export function nextCover(state: State, plan: StoredPlan, session: Session, asked: string[]) {
  const original = plan.sessionChanges.find((change) => change.sessionId === session.id)?.before.instructorId;
  const staying = state.bookings.filter((booking) => booking.sessionId === session.id && isActiveBooking(booking))
    .map((booking) => state.customers.find((customer) => customer.id === booking.customerId));
  return [...state.instructors].sort((a, b) => a.id.localeCompare(b.id)).find((instructor) => !asked.includes(instructor.id)
    && feasibilityErrors(state, { ...session, instructorId: instructor.id }, plan.disruption, new Date().toISOString()).length === 0
    && staying.every((customer) => !!customer && (instructor.id === original || customer.prefs.acceptsSubstitute || !!customer.prefs.preferredInstructorIds?.includes(instructor.id))));
}

/** After a decline, give the class to the next suitable instructor and send them their own cover link. */
export async function askNextCover(workspaceId: string, planId: string, sessionId: string, repository = getRepository()) {
  await withWorkspaceLock(repository, workspaceId, () => repository.transaction(() => {
    const plan = repository.getPlan(workspaceId, planId);
    if (!plan || plan.status === "proposed") throw new StoreError(404, "Recovery not found");
    const { state } = repository.requireReadyWorkspace(workspaceId);
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) throw new StoreError(410, "This class is no longer on the schedule.");
    if (Date.parse(session.start) <= Date.now()) throw new StoreError(409, "This class has already started.");
    const links = repository.listCoverLinks(workspaceId).filter((item) => item.planId === planId && item.sessionId === sessionId);
    if (links.find((item) => item.instructorId === session.instructorId)?.status !== "declined") throw new StoreError(409, "Only a declined cover can be passed to another instructor.");
    const next = nextCover(state, plan, session, links.map((item) => item.instructorId));
    if (!next) throw new StoreError(409, "No other qualified instructor is free for this class. Plan a new recovery for it.");
    const previous = state.instructors.find((item) => item.id === session.instructorId)?.name;
    session.instructorId = next.id;
    repository.saveState(workspaceId, state);
    repository.createCoverLink({ workspaceId, planId, sessionId, instructorId: next.id, status: "asked", fee: coverFee(payRule(state, next.id), coverAttendees(state, sessionId)) });
    // Customers still booked were told who would teach. Rewrite their message and mark it unsent so the owner sends the update.
    const revisedAt = new Date().toISOString();
    for (const link of repository.listCustomerLinks(workspaceId).filter((item) => item.planId === planId
      && state.bookings.some((booking) => booking.id === item.bookingId && booking.sessionId === sessionId && isActiveBooking(booking)))) {
      const body = previous ? link.message.body.split(previous).join(next.name) : link.message.body;
      repository.saveCustomerLink({ ...link, sentAt: undefined, revisedAt, ...(link.after ? { after: { ...link.after, instructorId: next.id } } : {}),
        message: { subject: `New instructor for your ${session.title} class`, body: body.replace(/^(Hi [^\n]*,\n\n)/, `$1Update: ${next.name} is now teaching this class${previous ? ` instead of ${previous}` : ""}. `) } });
    }
  }));
  return ownerCovers(workspaceId, repository);
}

/** The owner's cover list, with each private instructor link. Earlier asks stay listed as history. */
export function ownerCovers(workspaceId: string, repository = getRepository()) {
  void refreshCoverPayouts(workspaceId, repository).catch(() => {});
  const links = repository.listCoverLinks(workspaceId);
  return links.map((link) => {
    const { state, session, instructor, original, payout, current } = details(link, repository);
    const when = session ? new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(session.start)) : "";
    const plan = current && link.status === "declined" && session && Date.parse(session.start) > Date.now() ? repository.getPlan(workspaceId, link.planId) : undefined;
    const next = plan && session ? nextCover(state, plan, session, links.filter((item) => item.planId === link.planId && item.sessionId === link.sessionId).map((item) => item.instructorId)) : undefined;
    return { planId: link.planId, sessionId: link.sessionId, instructorId: link.instructorId, instructor, original, class: session?.title ?? "Class", when,
      status: link.withdrawnBy ? "withdrawn" as const : current || link.status === "declined" ? link.status : "replaced" as const, current,
      respondedBy: link.respondedBy, ...feeDetails(link, state, session, payout), path: `/i/${repository.coverToken(link)}`, payout,
      payee: Boolean(process.env.PAYPAL_PAYOUT_RECEIVER?.trim()), ...(plan ? { next: next?.name ?? null } : {}) };
  });
}
export type OwnerCover = ReturnType<typeof ownerCovers>[number];

export async function updateInstructorPay(workspaceId: string, instructorId: string, input: z.infer<typeof PayRuleUpdateSchema>, repository = getRepository()) {
  const update = PayRuleUpdateSchema.parse(input);
  await withWorkspaceLock(repository, workspaceId, () => repository.transaction(() => {
    const { state } = repository.requireReadyWorkspace(workspaceId);
    const instructor = state.instructors.find((item) => item.id === instructorId);
    if (!instructor) throw new StoreError(404, "Instructor not found");
    if ("reset" in update) delete instructor.pay;
    else instructor.pay = update;
    repository.saveState(workspaceId, state);
    const payouts = repository.listCoverPayouts(workspaceId);
    for (const link of repository.listCoverLinks(workspaceId).filter((item) => item.instructorId === instructorId)) {
      const payout = payouts.find((item) => item.planId === link.planId && item.sessionId === link.sessionId && item.instructorId === instructorId);
      if (editablePay(payout)) repository.saveCoverLink({ ...link, fee: coverFee(payRule(state, instructorId), coverAttendees(state, link.sessionId)) });
    }
  }));
  return ownerCovers(workspaceId, repository);
}

/** Replays of an unconfirmed payout stop a day inside PayPal's 30-day duplicate check on sender_batch_id. */
const PAYOUT_REPLAY_DAYS = 29;

/** Owner-initiated PayPal payout. A REQUESTED row is written first; an unknown outcome replays the same request id. */
export async function payCover(workspaceId: string, planId: string, sessionId: string, repository = getRepository()) {
  const receiver = process.env.PAYPAL_PAYOUT_RECEIVER?.trim();
  if (!receiver) throw new StoreError(503, "Cover payouts need a sandbox payee (PAYPAL_PAYOUT_RECEIVER).");
  return withWorkspaceLock(repository, workspaceId, async (owner) => {
    const asked = repository.listCoverLinks(workspaceId).filter((item) => item.planId === planId && item.sessionId === sessionId);
    const teaching = repository.requireWorkspace(workspaceId).state.sessions.find((item) => item.id === sessionId)?.instructorId;
    const link = asked.find((item) => item.instructorId === teaching) ?? asked.at(-1);
    if (!link) throw new StoreError(404, "Cover not found");
    if (link.withdrawnBy) throw new StoreError(409, "This class went back to its regular instructor. Existing payouts stay recorded.");
    if (link.status !== "accepted") throw new StoreError(409, "Pay a cover only after the instructor accepts it.");
    const { session, current } = details(link, repository);
    const paidBefore = repository.listCoverPayouts(workspaceId).some((item) => item.planId === planId && item.sessionId === sessionId);
    if (!current && !paidBefore) throw new StoreError(409, "A later schedule change gave this class to someone else.");
    const payout = repository.transaction(() => {
      const previous = repository.listCoverPayouts(workspaceId).find((item) => item.planId === planId && item.sessionId === sessionId);
      if (previous && previous.status !== "REQUESTED" && payoutLocks(previous)) throw new StoreError(409, previous.status === "SUCCESS" ? "This cover is already paid." : "This payout is already with PayPal.");
      // PayPal rejects a repeated sender_batch_id for 30 days. Past that, a replay could pay twice, so stop and ask for a check.
      if (previous?.status === "REQUESTED" && Date.parse(previous.createdAt) + PAYOUT_REPLAY_DAYS * 86_400_000 <= Date.now()) {
        throw new StoreError(409, "PayPal never confirmed this payout and it is too old to resend safely. Check PayPal before paying another way.");
      }
      const now = new Date().toISOString(), attempt = previous?.status === "REQUESTED" ? previous.attempt : (previous?.attempt ?? 0) + 1;
      const { state } = repository.requireWorkspace(workspaceId);
      const fee = previous?.status === "REQUESTED" ? previous.amount : coverFee(payRule(state, link.instructorId), coverAttendees(state, sessionId));
      repository.saveCoverLink({ ...link, fee });
      const next: CoverPayout = previous?.status === "REQUESTED" ? { ...previous, updatedAt: now } : { workspaceId, planId, sessionId, instructorId: link.instructorId,
        amount: fee, attempt, requestId: `cover-${planId}-${sessionId}-${attempt}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120), status: "REQUESTED", createdAt: now, updatedAt: now };
      repository.saveCoverPayout(next); return next;
    });
    const studio = repository.requireWorkspace(workspaceId).state.studio.name;
    try {
      const result = await createPayout({ requestId: payout.requestId, receiver, amount: payout.amount, subject: `${studio} cover pay`,
        note: `Cover: ${session?.title ?? "class"} ${session ? new Date(session.start).toISOString().slice(0, 10) : ""}`.trim() });
      repository.renewLock(workspaceId, owner);
      repository.saveCoverPayout({ ...payout, status: "PENDING", batchId: result.batchId, error: undefined, updatedAt: new Date().toISOString() });
    } catch (error) {
      // Only a rejection of a first send proves no money moved. A replay of an unknown attempt (e.g. PayPal's duplicate
      // batch answer) may mean the original payout exists, so it stays REQUESTED with the same id and never gets a new one.
      const replay = payout.createdAt !== payout.updatedAt;
      if (!replay && error instanceof PayPalError && error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status) && !/DUPLICATE/i.test(`${error.name} ${error.message}`)) {
        repository.saveCoverPayout({ ...payout, status: "FAILED", error: `PayPal declined the payout (${error.name}).`, updatedAt: new Date().toISOString() });
      } else {
        if (error instanceof PayPalError) repository.saveCoverPayout({ ...payout, error: "PayPal may already have this payout. Check it in PayPal before paying another way.", updatedAt: new Date().toISOString() });
        throw new StoreError(502, "PayPal did not confirm the payout yet. Check again before paying another way.");
      }
    }
    return ownerCovers(workspaceId, repository);
  });
}

const lastRefresh = globalThis as typeof globalThis & { rebookCoverRefresh?: Map<string, number> };
/** Read-only status checks for payouts PayPal has accepted, at most every 10 s per workspace. */
export async function refreshCoverPayouts(workspaceId: string, repository = getRepository()): Promise<void> {
  const seen = lastRefresh.rebookCoverRefresh ??= new Map();
  if ((seen.get(workspaceId) ?? 0) + 10_000 > Date.now()) return;
  seen.set(workspaceId, Date.now());
  // Unclaimed payouts can stay open for 30 days at PayPal; keep reconciling a little beyond that.
  const open = repository.listCoverPayouts(workspaceId).filter((item) => item.batchId && ["PENDING", "UNCLAIMED", "ONHOLD"].includes(item.status)
    && Date.parse(item.createdAt) + 35 * 86_400_000 > Date.now());
  for (const payout of open) {
    const state = await getPayout(payout.batchId!);
    const status = state.batchStatus === "DENIED" ? "DENIED" : ITEM_STATUSES.find((item) => item === state.itemStatus);
    if (!status) continue;
    repository.transaction(() => {
      const current = repository.listCoverPayouts(workspaceId).find((item) => item.planId === payout.planId && item.sessionId === payout.sessionId);
      // Compare with the snapshot read before the fetch, so an older response cannot overwrite a newer status.
      if (current?.requestId !== payout.requestId || current.status !== payout.status || current.updatedAt !== payout.updatedAt
        || current.status === status && current.itemId === state.itemId) return;
      repository.saveCoverPayout({ ...current, status, itemId: state.itemId ?? current.itemId, error: state.error, updatedAt: new Date().toISOString() });
    });
  }
}
