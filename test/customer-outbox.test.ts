import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftCustomerMessages } from "../lib/ai/messages";
import { createCustomerLinks, markCustomerContact, ownerCustomerChoices, submitChoice } from "../lib/choices/service";
import { draftOutbox, messageDeepLinks, outboxMessage, outboxState, summarizeOutbox, waitingCustomers } from "../lib/choices/outbox";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { applyPlan } from "../lib/solver/validate";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import { POST } from "../app/api/workspaces/[id]/outbox/route";
import { GET as ownerGET } from "../app/api/workspaces/[id]/route";
import { GET as customerGET } from "../app/api/choices/[token]/route";

let directory: string, repository: Repository;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "rebook-outbox-")); vi.stubEnv("DATA_DIR", directory);
  repository = getRepository();
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.useRealTimers(); });

function fixture() {
  const before = seedStudio();
  for (const booking of before.bookings) booking.payment = { ...booking.payment!, simulated: true };
  const { id } = repository.createWorkspace(before);
  const plan = { ...repository.createPlan(id, replan(before, demoDisruption, { now: new Date().toISOString() })), status: "executed" as const };
  const after = applyPlan(before, plan);
  repository.saveState(id, after); repository.savePlan(plan); createCustomerLinks(plan, before, after, repository);
  for (const booking of before.bookings) repository.appendLedger({ workspaceId: id, bookingId: booking.id, kind: "capture", amount: booking.amount,
    paypalId: booking.payment!.captureId, captureId: booking.payment!.captureId, requestId: `capture:${booking.id}`, status: "SIMULATED" });
  const rows = () => ownerCustomerChoices(id, repository).outbox;
  return { id, plan, before, rows };
}

describe("durable owner outbox", () => {
  it("groups affected bookings by customer, includes changes and private link kinds, and leaves hero totals unchanged", () => {
    const { plan, rows, before } = fixture();
    expect(plan.totals).toMatchObject({ kept: 9, moved: 16, refunded: 6, revenueKept: "577.00", refundAmount: "135.00" });
    expect(rows()).toHaveLength(new Set(plan.bookingActions.map((action) => action.customerId)).size);
    expect(rows().flatMap((row) => row.changes)).toHaveLength(plan.bookingActions.length);
    expect(rows().every((row) => row.customerName === before.customers.find((customer) => customer.id === row.customerId)?.name)).toBe(true);
    expect(rows().flatMap((row) => row.changes).every((change) => change.body && change.subject && change.path?.startsWith("/c/"))).toBe(true);
    expect(rows().flatMap((row) => row.changes).filter((change) => change.kind === "receipt")).toHaveLength(6);
    const drafts = draftOutbox(draftCustomerMessages(plan, before));
    expect(drafts).toHaveLength(rows().length); expect(drafts[0].customerName).not.toBe("Customer");
  });

  it("moves from not sent to sent to customer reply, persists on reopen, and undoes contact without erasing the reply", async () => {
    const { id, plan, rows } = fixture();
    const row = rows().find((item) => item.changes.every((change) => change.kind === "choice"))!;
    expect(outboxState(row)).toMatchObject({ sent: false, replied: false, waiting: false });
    await markCustomerContact(id, plan.id, row.customerId, true, repository);
    expect(outboxState(rows().find((item) => item.customerId === row.customerId)!)).toMatchObject({ sent: true, replied: false, waiting: true, sentAt: "2026-11-05T12:00:00.000Z" });
    closeRepository(); repository = getRepository();
    expect(outboxState(rows().find((item) => item.customerId === row.customerId)!)).toMatchObject({ sent: true, waiting: true });
    for (const change of row.changes) await submitChoice(change.path!.split("/").at(-1)!, { action: "keep" }, repository);
    const replied = rows().find((item) => item.customerId === row.customerId)!;
    expect(outboxState(replied)).toMatchObject({ sent: true, replied: true, waiting: false });
    expect(replied.changes.every((change) => ["kept", "moved"].includes(change.reply!.status))).toBe(true);
    await markCustomerContact(id, plan.id, row.customerId, false, repository);
    expect(outboxState(rows().find((item) => item.customerId === row.customerId)!)).toMatchObject({ sent: false, replied: true, waiting: false });
    closeRepository(); repository = getRepository();
    expect(rows().find((item) => item.customerId === row.customerId)!.changes.every((change) => !change.sentAt && change.reply)).toBe(true);
  });

  it("saves and undoes one contact timestamp across multiple affected bookings for the same customer", async () => {
    const { id, plan, rows } = fixture();
    const [first, second] = rows();
    const { state } = repository.requireWorkspace(id);
    state.bookings.find((booking) => booking.id === second.changes[0].bookingId)!.customerId = first.customerId;
    repository.saveState(id, state);
    const grouped = rows().find((row) => row.customerId === first.customerId)!;
    expect(grouped.changes.length).toBeGreaterThan(1);
    await markCustomerContact(id, plan.id, first.customerId, true, repository);
    expect(rows().find((row) => row.customerId === first.customerId)!.changes.every((change) => change.sentAt === "2026-11-05T12:00:00.000Z")).toBe(true);
    expect(summarizeOutbox(rows()).sent).toBe(1);
    const message = outboxMessage(grouped, "https://studio.test");
    for (const change of grouped.changes) expect(message).toContain(new URL(change.path!, "https://studio.test").href);
    await markCustomerContact(id, plan.id, first.customerId, false, repository);
    expect(rows().find((row) => row.customerId === first.customerId)!.changes.every((change) => !change.sentAt)).toBe(true);
  });

  it("reports kept, moved, another-class and refund replies from existing choices", async () => {
    const { id, plan, rows, before } = fixture();
    const choice = rows().flatMap((row) => row.changes).find((change) => change.kind === "choice")!;
    const link = repository.listCustomerLinks(id).find((item) => item.bookingId === choice.bookingId)!;
    const action = plan.bookingActions.find((item) => item.bookingId === choice.bookingId)!;
    for (const [input, label] of [["keep", action.action === "move" ? "moved" : "kept"], ["move", "chose another class"], ["refund", "refund requested"]] as const) {
      repository.saveCustomerLink({ ...link, reply: { action: input, at: new Date().toISOString(), amount: "0.00" } });
      expect(rows().flatMap((row) => row.changes).find((change) => change.bookingId === choice.bookingId)?.reply?.status).toBe(label);
    }
    expect(before.customers.length).toBe(120);
  });

  it("counts customers once, keeps partial replies waiting, and excludes unsent messages and receipts from reminders", async () => {
    const { id, plan, rows } = fixture();
    const initial = rows();
    expect(summarizeOutbox(initial)).toEqual({ sent: 0, replied: 0, waiting: 0, closed: 0, notSent: initial.length });
    const choice = initial.find((row) => row.changes.every((change) => change.kind === "choice"))!;
    const receipt = initial.find((row) => row.changes.every((change) => change.kind === "receipt"))!;
    await markCustomerContact(id, plan.id, choice.customerId, true, repository);
    await markCustomerContact(id, plan.id, receipt.customerId, true, repository);
    expect(summarizeOutbox(rows())).toEqual({ sent: 2, replied: 0, waiting: 1, closed: 0, notSent: initial.length - 2 });
    expect(waitingCustomers(rows()).map((row) => row.customerId)).toEqual([choice.customerId]);
    const partial = { ...choice, changes: [...choice.changes.map((change) => ({ ...change, sentAt: "now", reply: { status: "kept" as const, at: "now" } })), { ...choice.changes[0], sentAt: "now" }] };
    expect(outboxState(partial)).toMatchObject({ replied: false, waiting: true });
    const reminder = outboxMessage(partial, "https://studio.test", true);
    expect(reminder.match(/https:\/\/studio.test\/c\//g)).toHaveLength(1);
    expect(reminder).toContain("just a reminder"); expect(reminder).not.toContain(choice.changes[0].body);
    // Once the choice closes (class started or a week passed) the customer is no longer waiting or reminded.
    const closed = { ...choice, changes: choice.changes.map((change) => ({ ...change, sentAt: "now", expiresAt: Date.now() - 1 })) };
    expect(outboxState(closed)).toMatchObject({ waiting: false, closed: true });
    expect(waitingCustomers([closed])).toEqual([]);
    expect(summarizeOutbox([closed])).toMatchObject({ waiting: 0, closed: 1 });
  });

  it("validates owner writes, rejects foreign origins and other workspaces, and keeps sent status out of customer responses", async () => {
    const { id, plan, rows } = fixture(); const row = rows()[0];
    const request = (body: unknown, workspace = id, origin = "http://localhost") => POST(new Request(`http://localhost/api/workspaces/${workspace}/outbox`, {
      method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: workspace }) });
    const input = { planId: plan.id, customerId: row.customerId, sent: true };
    expect((await request({ ...input, sentAt: "fake" })).status).toBe(400);
    expect((await request({ ...input, sent: "yes" })).status).toBe(400);
    expect((await request(input, id, "http://other.test")).status).toBe(403);
    const other = repository.createWorkspace(seedStudio());
    expect((await request(input, other.id)).status).toBe(404);
    expect((await request({ ...input, customerId: "missing" })).status).toBe(404);
    const response = await request(input); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    const owner = await ownerGET(new Request(`http://localhost/api/workspaces/${id}`), { params: Promise.resolve({ id }) });
    expect((await owner.json()).customerChoices.outbox.find((item: { customerId: string }) => item.customerId === row.customerId).changes[0].sentAt).toBe("2026-11-05T12:00:00.000Z");
    const token = row.changes[0].path!.split("/").at(-1)!;
    const customer = await customerGET(new Request(`http://localhost/api/choices/${token}`), { params: Promise.resolve({ token }) });
    expect(customer.status).toBe(200); const text = await customer.text();
    expect(text).not.toContain("sentAt"); expect(text).not.toContain("outbox"); expect(text).not.toContain(id);
  });
});

it("encodes special characters, Unicode, private links and line breaks exactly once in all app deep links", () => {
  const subject = "Yoga & dance? #1 — café + 50%";
  const body = "Hi Asha & Jo,\n\nIt's moved + ready? 50% #yes 🙏\nhttps://studio.test/c/private_token";
  const links = messageDeepLinks(subject, body);
  expect(new URL(links.whatsapp).pathname).toBe("/");
  expect(new URL(links.whatsapp).searchParams.get("text")).toBe(body);
  expect(links.sms).toBe(`sms:?&body=${encodeURIComponent(body)}`);
  expect(new URL(links.sms).searchParams.get("body")).toBe(body);
  expect(new URL(links.email).searchParams.get("subject")).toBe(subject);
  expect(new URL(links.email).searchParams.get("body")).toBe(body);
  expect(links.whatsapp).toContain("%0A%0A"); expect(links.whatsapp).not.toContain("%250A");
});
