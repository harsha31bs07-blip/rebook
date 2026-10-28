import { z } from "zod";
import type { State } from "../domain/types";
import { PayPalError } from "../paypal/client";
import { createPayout, getPayout } from "../paypal/payouts";
import { getRepository, StoreError, withWorkspaceLock, type CoverLink, type CoverPayout, type Repository, type StoredPlan } from "../store";
import { planCovers } from "./covers";

/** The studio's standard per-class cover fee for the demo. */
export const COVER_FEE = "35.00";
export const CoverTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const ACTIVE = ["REQUESTED", "PENDING", "UNCLAIMED", "ONHOLD"];
const ITEM_STATUSES = ["SUCCESS", "FAILED", "PENDING", "UNCLAIMED", "RETURNED", "ONHOLD", "BLOCKED", "REFUNDED", "REVERSED"] as const;

/** After approval, each substitute gets a private accept/decline link; an owner-confirmed cover starts accepted. */
export function createCoverLinks(plan: StoredPlan, basis: State, repository: Repository): void {
  for (const cover of planCovers(plan, basis)) {
    const confirmed = plan.coverConfirmations?.find((item) => item.sessionId === cover.sessionId && item.instructorId === cover.instructorId);
    repository.createCoverLink({ workspaceId: plan.workspaceId, planId: plan.id, sessionId: cover.sessionId, instructorId: cover.instructorId,
      status: confirmed ? "accepted" : "asked", ...(confirmed ? { respondedAt: confirmed.confirmedAt, respondedBy: "owner" as const } : {}), fee: COVER_FEE });
  }
}

function details(link: CoverLink, repository: Repository) {
  const { state } = repository.requireWorkspace(link.workspaceId, true);
  const plan = repository.getPlan(link.workspaceId, link.planId);
  const session = state.sessions.find((item) => item.id === link.sessionId);
  const change = plan?.sessionChanges.find((item) => item.sessionId === link.sessionId);
  const name = (id?: string) => state.instructors.find((item) => item.id === id)?.name ?? "Studio team";
  const payout = repository.listCoverPayouts(link.workspaceId).find((item) => item.planId === link.planId && item.sessionId === link.sessionId);
  return { state, session, instructor: name(link.instructorId), original: name(change?.before.instructorId),
    payout: payout && { status: payout.status, amount: payout.amount, itemId: payout.itemId, error: payout.error } };
}
const payoutLocks = (payout?: { status: string }) => !!payout && ACTIVE.concat("SUCCESS").includes(payout.status);

/** Public instructor view: the class, the fee and the payout. No customer data. */
export function coverView(token: string, repository = getRepository()) {
  const link = repository.coverLinkByToken(CoverTokenSchema.parse(token));
  if (!link) throw new StoreError(404, "This cover link is not valid.");
  void refreshCoverPayouts(link.workspaceId, repository).catch(() => {});
  return viewOf(link, repository);
}
function viewOf(link: CoverLink, repository: Repository) {
  const { state, session, instructor, original, payout } = details(link, repository);
  if (!session) throw new StoreError(410, "This class is no longer on the schedule.");
  return { studio: { name: state.studio.name, timezone: state.studio.timezone }, status: link.status, fee: link.fee, instructor, original,
    class: { title: session.title, start: session.start, end: session.end, room: state.rooms.find((room) => room.id === session.roomId)?.name ?? "Studio" },
    payout, canRespond: !payoutLocks(payout) && Date.parse(session.start) > Date.now() };
}
export type CoverView = ReturnType<typeof viewOf>;

export async function respondToCover(token: string, action: "accept" | "decline", repository = getRepository()) {
  const initial = repository.coverLinkByToken(CoverTokenSchema.parse(token));
  if (!initial) throw new StoreError(404, "This cover link is not valid.");
  await withWorkspaceLock(repository, initial.workspaceId, () => repository.transaction(() => {
    const link = repository.coverLinkByToken(token)!;
    const view = viewOf(link, repository);
    if (!view.canRespond) throw new StoreError(409, view.payout ? "This cover has already been paid." : "This class has already started.");
    const status = action === "accept" ? "accepted" : "declined";
    if (link.status !== status) repository.saveCoverLink({ ...link, status, respondedAt: new Date().toISOString(), respondedBy: "instructor" });
  }));
  return coverView(token, repository);
}

/** The owner's cover list, with each private instructor link. */
export function ownerCovers(workspaceId: string, repository = getRepository()) {
  void refreshCoverPayouts(workspaceId, repository).catch(() => {});
  return repository.listCoverLinks(workspaceId).map((link) => {
    const { state, session, instructor, original, payout } = details(link, repository);
    const when = session ? new Intl.DateTimeFormat("en-US", { timeZone: state.studio.timezone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(session.start)) : "";
    return { planId: link.planId, sessionId: link.sessionId, instructor, original, class: session?.title ?? "Class", when, status: link.status,
      respondedBy: link.respondedBy, fee: link.fee, path: `/i/${repository.coverToken(link)}`, payout, payee: Boolean(process.env.PAYPAL_PAYOUT_RECEIVER?.trim()) };
  });
}
export type OwnerCover = ReturnType<typeof ownerCovers>[number];

/** Owner-initiated PayPal payout. A REQUESTED row is written first; an unknown outcome replays the same request id. */
export async function payCover(workspaceId: string, planId: string, sessionId: string, repository = getRepository()) {
  const receiver = process.env.PAYPAL_PAYOUT_RECEIVER?.trim();
  if (!receiver) throw new StoreError(503, "Cover payouts need a sandbox payee (PAYPAL_PAYOUT_RECEIVER).");
  return withWorkspaceLock(repository, workspaceId, async (owner) => {
    const link = repository.listCoverLinks(workspaceId).find((item) => item.planId === planId && item.sessionId === sessionId);
    if (!link) throw new StoreError(404, "Cover not found");
    if (link.status !== "accepted") throw new StoreError(409, "Pay a cover only after the instructor accepts it.");
    const { session } = details(link, repository);
    const payout = repository.transaction(() => {
      const previous = repository.listCoverPayouts(workspaceId).find((item) => item.planId === planId && item.sessionId === sessionId);
      if (previous && previous.status !== "REQUESTED" && payoutLocks(previous)) throw new StoreError(409, previous.status === "SUCCESS" ? "This cover is already paid." : "This payout is already with PayPal.");
      const now = new Date().toISOString(), attempt = previous?.status === "REQUESTED" ? previous.attempt : (previous?.attempt ?? 0) + 1;
      const next: CoverPayout = previous?.status === "REQUESTED" ? { ...previous, updatedAt: now } : { workspaceId, planId, sessionId, instructorId: link.instructorId,
        amount: link.fee, attempt, requestId: `cover-${planId}-${sessionId}-${attempt}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120), status: "REQUESTED", createdAt: now, updatedAt: now };
      repository.saveCoverPayout(next); return next;
    });
    const studio = repository.requireWorkspace(workspaceId).state.studio.name;
    try {
      const result = await createPayout({ requestId: payout.requestId, receiver, amount: payout.amount, subject: `${studio} cover pay`,
        note: `Cover: ${session?.title ?? "class"} ${session ? new Date(session.start).toISOString().slice(0, 10) : ""}`.trim() });
      repository.renewLock(workspaceId, owner);
      repository.saveCoverPayout({ ...payout, status: "PENDING", batchId: result.batchId, error: undefined, updatedAt: new Date().toISOString() });
    } catch (error) {
      // A definitive rejection may be retried with a new attempt; anything else stays REQUESTED and replays the same id.
      if (error instanceof PayPalError && error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status)) {
        repository.saveCoverPayout({ ...payout, status: "FAILED", error: `PayPal declined the payout (${error.name}).`, updatedAt: new Date().toISOString() });
      } else throw new StoreError(502, "PayPal did not confirm the payout yet. Check again before paying another way.");
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
  const open = repository.listCoverPayouts(workspaceId).filter((item) => item.batchId && ["PENDING", "UNCLAIMED", "ONHOLD"].includes(item.status)
    && Date.parse(item.createdAt) + 7 * 86_400_000 > Date.now());
  for (const payout of open) {
    const state = await getPayout(payout.batchId!);
    const status = state.batchStatus === "DENIED" ? "DENIED" : ITEM_STATUSES.find((item) => item === state.itemStatus);
    if (!status) continue;
    repository.transaction(() => {
      const current = repository.listCoverPayouts(workspaceId).find((item) => item.planId === payout.planId && item.sessionId === payout.sessionId);
      if (current?.requestId !== payout.requestId || current.status === status && current.itemId === state.itemId) return;
      repository.saveCoverPayout({ ...current, status, itemId: state.itemId ?? current.itemId, error: state.error, updatedAt: new Date().toISOString() });
    });
  }
}
