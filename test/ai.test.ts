import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AiUnavailable, generateJson } from "../lib/ai/gemini";
import { hardSafetyStop, interpretDisruption, interpretRules } from "../lib/ai/interpret";
import messyCorpus from "./fixtures/interpret-messy.json";
import corpus from "./fixtures/interpret-eval.json";
import { scoreCase } from "../scripts/eval-interpret.mjs";
import { explainPlan } from "../lib/ai/explain";
import { draftCustomerMessages } from "../lib/ai/messages";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { localParts } from "../lib/domain/time";
import type { Plan } from "../lib/domain/types";
import { POST as interpret } from "../app/api/workspaces/[id]/interpret/route";
import { POST as propose } from "../app/api/workspaces/[id]/plans/route";
import { closeRepository, getRepository } from "../lib/store";
import { limits } from "../lib/api/limits";

const now = "2026-11-08T15:00:00Z";
const state = seedStudio();
const weekStart = "2026-11-09T05:00:00.000Z";
const objectSchema = { type: "OBJECT", properties: { ok: { type: "BOOLEAN" } }, required: ["ok"] };
const OkSchema = z.object({ ok: z.boolean() });
const response = (data: unknown) => Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify(data) } }] });
const intent = (overrides: Record<string, unknown> = {}) => ({
  kind: "instructor_unavailable", name: "Maya Chen", day: "monday", untilDay: null,
  startTime: null, endTime: null, period: "all_day", thisWeek: false, confidence: 0.95, notes: [], ...overrides,
});
let epoch = Date.now();
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  limits.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(epoch += 120_000);
  vi.stubEnv("AI_MODELS", undefined); vi.stubEnv("GROQ_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "test-key-never-real");
  vi.stubEnv("GEMINI_MODELS", "first,second,third");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("provider JSON generation", () => {
  it("tries models in env order after 503 and sends JSON schema without logging secrets", async () => {
    const log = vi.spyOn(console, "error");
    fetchMock.mockResolvedValueOnce(new Response("high demand", { status: 503 })).mockResolvedValueOnce(response({ ok: true }));
    const result = await generateJson("test prompt", objectSchema, OkSchema);
    expect(result).toMatchObject({ data: { ok: true }, model: "second" });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/v1beta/openai/chat/completions", "/v1beta/openai/chat/completions",
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "rebook_response", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } });
    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).model)).toEqual(["first", "second"]);
    expect(log).not.toHaveBeenCalled();
  });
  it("aborts a hung request after 10 seconds and tries the next model", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(response({ ok: true }));
    const pending = generateJson("test", objectSchema, OkSchema);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).model).toBe("second");
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("limits all models and stalled response bodies to a shared 35 second budget", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
    const outcome = generateJson("test", objectSchema, OkSchema).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(await outcome).toBeInstanceOf(AiUnavailable);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([, opts]) => opts.signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects malformed JSON and zod-invalid output before accepting a valid model", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "not json" } }] }))
      .mockResolvedValueOnce(response({ ok: "yes" })).mockResolvedValueOnce(response({ ok: true }));
    expect((await generateJson("test", objectSchema, OkSchema)).model).toBe("third");
  });
  it("rejects invalid output from every model", async () => {
    fetchMock.mockImplementation(async () => response({ ok: "yes" }));
    await expect(generateJson("test", objectSchema, OkSchema)).rejects.toBeInstanceOf(AiUnavailable);
  });
  it("retries 429, stops on authentication errors, and never needs a network call without a key", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(response({ ok: true }));
    expect((await generateJson("test", objectSchema, OkSchema)).model).toBe("second");
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 401 }));
    await expect(generateJson("test", objectSchema, OkSchema)).rejects.toBeInstanceOf(AiUnavailable);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.stubEnv("GEMINI_API_KEY", "");
    fetchMock.mockClear();
    await expect(generateJson("test", objectSchema, OkSchema)).rejects.toBeInstanceOf(AiUnavailable);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("disruption interpretation", () => {
  it("uses Groq after Gemini overload and reports the actual provider", async () => {
    vi.stubEnv("AI_MODELS", "gemini:first,groq:llama-3.3-70b-versatile");
    vi.stubEnv("GROQ_API_KEY", "groq-test-key");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(response(intent()));
    expect(await interpretDisruption("Maya is sick Monday", state, now, weekStart)).toMatchObject({ source: "groq", model: "llama-3.3-70b-versatile", disruption: { instructorId: "instructor-01" } });
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.groq.com/openai/v1/chat/completions");
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.response_format.json_schema.schema.properties.name.type).toEqual(["string", "null"]);
    expect(body.response_format.json_schema.schema.properties.day.enum).toContain(null);
  });
  it.each([
    ["Maya has the flu and can't teach Monday", "instructor_unavailable", "2026-11-09T05:00:00.000Z", "2026-11-10T05:00:00.000Z"],
    ["Cycle Lab AC broken Wed afternoon", "room_unavailable", "2026-11-11T17:00:00.000Z", "2026-11-11T22:00:00.000Z"],
    ["studio closed Saturday for a burst pipe", "closure", "2026-11-14T05:00:00.000Z", "2026-11-15T05:00:00.000Z"],
    ["Maya is sick Monday to Wednesday", "instructor_unavailable", "2026-11-09T05:00:00.000Z", "2026-11-12T05:00:00.000Z"],
    ["Alex is unavailable this week", "instructor_unavailable", "2026-11-09T05:00:00.000Z", "2026-11-16T05:00:00.000Z"],
  ])("preserves the complete window for %s on provider outage", async (text, kind, from, to) => {
    fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));
    expect(await interpretDisruption(text, state, now, weekStart)).toMatchObject({ source: "rules", disruption: { kind, from, to, reason: text } });
  });
  it("preserves the hero plan's 9/16/6 outcome", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const result = await interpretDisruption("Maya has the flu and can't teach Monday", state, now, weekStart);
    if (result.kind === "clarify") throw new Error(result.question);
    expect(result.disruption).toEqual({ ...demoDisruption, reason: "Maya has the flu and can\'t teach Monday" });
    expect(replan(state, result.disruption, { now }).totals).toMatchObject({ kept: 9, moved: 16, refunded: 6 });
  });
  it.each([
    "Maya is not sick Monday", "Maya is no longer out Monday", "cancel that", "Maya might be sick Monday",
    "If Maya is sick Monday", "Maya is sick Monday, actually Tuesday", "Maya was sick Monday",
    "Beatrice is sick Monday", "Studio B flooded Wed", "Maya and Alex are sick Monday",
    "Maya and Beatrice are sick Monday", "Maya is sick", "Maya is sick Monday at 2pm",
    "Alex can't do evenings this week", "Maya is out until Wednesday", "Maya is sick Monday and Wednesday",
  ])("clarifies %s even with an overconfident provider", async (text) => {
    fetchMock.mockResolvedValue(response(intent()));
    const result = await interpretDisruption(text, state, now, weekStart);
    expect(result).toMatchObject({ kind: "clarify", question: expect.any(String), suggestions: expect.any(Array) });
    expect(result).not.toHaveProperty("disruption");
    if (hardSafetyStop(text, state)) expect(fetchMock).not.toHaveBeenCalled();
  });
  // These clarify cases reach the model: unknown/unspecified names, missing days, ambiguous
  // illness-only wording or a report about somebody else. Text/resource validation rejects
  // even a confident invented Maya/Monday; malformed dates/times and ranges stop locally.
  const modelValidated = { messy: [32, 37, 40], original: [116, 127, 130, 135, 137, 150, 154, 155, 156] };
  it.each([
    ...messyCorpus.filter((item) => item.expected.clarify).map((item) => ({ ...item, corpus: "messy" as const })),
    ...corpus.filter((item) => item.expected.clarify).map((item) => ({ ...item, corpus: "original" as const })),
  ])("has zero dangerous outputs for $corpus $id: $input with an adversarial provider", async (item) => {
    fetchMock.mockResolvedValue(response(intent()));
    expect(await interpretDisruption(item.input, state, "2026-11-09T05:15:00Z")).toMatchObject({ kind: "clarify" });
    if (hardSafetyStop(item.input, state)) expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.length > 0, "All other clarify cases are protected before a provider call").toBe(modelValidated[item.corpus].includes(item.id));
  });
  it.each([
    { text: "Natalie called in sick for Tuesday", fields: { name: "Natalie", day: "tuesday" } },
    { text: "Chris is sick", fields: { name: "Chris Morgan", day: null } },
  ])("validates model resource/day fields for $text", async ({ text, fields }) => {
    fetchMock.mockResolvedValue(response(intent(fields)));
    expect(await interpretDisruption(text, state, "2026-11-09T05:15:00Z")).toMatchObject({ kind: "clarify" });
    expect(fetchMock).toHaveBeenCalled();
  });
  it("reads a forwarded absence only with owner confirmation, and rejects a different known name", async () => {
    const text = messyCorpus[0].input, clock = "2026-11-09T05:15:00Z";
    fetchMock.mockResolvedValueOnce(response(intent({ day: "today" })));
    expect(await interpretDisruption(text, state, clock)).toMatchObject({ needsConfirmation: true, source: "gemini", disruption: { ...demoDisruption, reason: text } });
    fetchMock.mockResolvedValue(response(intent({ name: "Alex Rivera", day: "today" })));
    expect(await interpretDisruption(text, state, clock)).toMatchObject({ kind: "clarify" });
  });
  it.each(messyCorpus.filter((item) => !item.expected.clarify))("accepts a correct model reading of messy $id: $input", async (item) => {
    const expected = item.expected, from = expected.window!.from, to = expected.window!.to;
    const day = (date: string) => ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][new Date(`${date.slice(0, 10)}T12:00:00Z`).getUTCDay()];
    const allDay = from.endsWith("00:00") && to.endsWith("00:00");
    const last = new Date(Date.parse(`${to}:00Z`) - 1).toISOString();
    fetchMock.mockResolvedValue(response(intent({ kind: expected.instructor ? "instructor_unavailable" : expected.room ? "room_unavailable" : "closure",
      name: expected.instructor ?? expected.room ?? null, day: day(from), throughDay: allDay && from.slice(0, 10) !== last.slice(0, 10) ? day(last) : null,
      startTime: allDay ? null : from.slice(11), endTime: allDay ? null : to.slice(11),
    })));
    const result = await interpretDisruption(item.input, state, "2026-11-09T05:15:00Z");
    expect(scoreCase(item, result, state), JSON.stringify(result)).toEqual({ correct: true, dangerous: false });
    if (interpretRules(item.input, state, "2026-11-09T05:15:00Z").kind === "clarify") expect(result).toHaveProperty("needsConfirmation", true);
  });
  it.each([
    "Maya won't be absent Monday", "Maya won't make it Monday provided her test is positive", "Maya won't make it Monday, sorry Tuesday",
    "Maya said she was unavailable Monday", "Can you check Maya is off Monday", "Maya and Natalie won't make it Monday",
  ])("stops %s before any provider call", async (text) => {
    fetchMock.mockResolvedValue(response(intent()));
    expect(await interpretDisruption(text, state, "2026-11-09T05:15:00Z")).toMatchObject({ kind: "clarify" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    { text: "Maya texted: won't make it Monday from 2pm to 4pm", fields: {} },
    { text: "Maya texted: won't make it Monday", fields: { day: "tuesday" } },
    { text: "Maya texted: won't make it Monday", fields: { throughDay: "wednesday" } },
    { text: "Maya texted: won't make it Monday evening", fields: {} },
    { text: "Maya Patel won't make it Monday", fields: {} },
    { text: "Maya says the studio won't let her teach Monday", fields: { kind: "closure", name: null } },
  ])("rejects a model window or resource the owner's words contradict: $text", async ({ text, fields }) => {
    fetchMock.mockResolvedValue(response(intent(fields)));
    expect(await interpretDisruption(text, state, "2026-11-09T05:15:00Z")).toMatchObject({ kind: "clarify" });
  });
  it("accepts the same AI-only reading when the window matches the owner's clock times", async () => {
    fetchMock.mockResolvedValue(response(intent({ startTime: "14:00", endTime: "16:00" })));
    expect(await interpretDisruption("Maya texted: won't make it Monday from 2pm to 4pm", state, "2026-11-09T05:15:00Z")).toMatchObject({ needsConfirmation: true });
  });
  it("keeps the hero rules-confirmed by Gemini without a confirmation flag", async () => {
    fetchMock.mockResolvedValue(response(intent()));
    const result = await interpretDisruption("Maya has the flu and can't teach Monday", state, now);
    expect(result).toMatchObject({ source: "gemini", disruption: { instructorId: "instructor-01" } });
    expect(result).not.toHaveProperty("needsConfirmation");
  });
  it.each([
    { day: null }, { confidence: 0.69 }, { startTime: "14:00", endTime: null },
    { name: "Natalie" },
  ])("rejects invalid AI-only fields: %j", async (override) => {
    fetchMock.mockResolvedValue(response(intent(override)));
    expect(await interpretDisruption(messyCorpus[0].input, state, "2026-11-09T05:15:00Z")).toMatchObject({ kind: "clarify" });
  });
  it("rejects an AI-only window that has already ended", async () => {
    fetchMock.mockResolvedValue(response(intent()));
    expect(await interpretDisruption("Maya texted: won't make it Monday", state, "2026-11-11T15:00:00Z")).toMatchObject({ kind: "clarify" });
  });
  it("rejects AI-only relative dates outside the studio week", async () => {
    fetchMock.mockResolvedValue(response(intent({ day: "today" })));
    expect(await interpretDisruption(messyCorpus[0].input, state, "2026-11-16T15:00:00Z")).toMatchObject({ kind: "clarify" });
  });
  it("preserves the original clarification on model clarification or outage", async () => {
    const text = messyCorpus[0].input, original = interpretRules(text, state, now);
    fetchMock.mockResolvedValueOnce(response({ kind: "clarify", question: "Invented question?", suggestions: [] }));
    expect(await interpretDisruption(text, state, now)).toEqual(original);
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    expect(await interpretDisruption(text, state, now)).toMatchObject({ ...original, aiBusy: true });
  });
  it.each([
    { name: "Beatrice Unknown" }, { name: "Alex Rivera" }, { day: "tuesday" },
    { startTime: "14:00", endTime: "16:00" }, { kind: "closure", name: null },
    { day: "today" }, { startTime: "25:00", endTime: "26:00" },
  ])("falls back without changing the owner's resource or window for %j", async (override) => {
    fetchMock.mockImplementation(async () => response(intent(override)));
    expect(await interpretDisruption("Maya is sick Monday", state, now, weekStart)).toMatchObject({ source: "rules", disruption: { instructorId: "instructor-01", from: demoDisruption.from, to: demoDisruption.to } });
  });
  it("accepts grounded model output, ignores invented IDs and uses deterministic notes", async () => {
    fetchMock.mockResolvedValue(response(intent({ instructorId: "attacker", notes: ["invented detail"] })));
    const result = await interpretDisruption("Maya is sick Monday", state, now, weekStart);
    expect(result).toMatchObject({ source: "gemini", model: "first", disruption: { instructorId: "instructor-01" } });
    expect(result).not.toHaveProperty("notes", ["invented detail"]);
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;
    expect(prompt).toContain("2026-11-08, sunday");
    expect(prompt).toContain("America/New_York");
  });
  it("accepts a structured model clarification and asks on low confidence", async () => {
    fetchMock.mockResolvedValueOnce(response({ kind: "clarify", question: "Which Monday?", suggestions: ["Maya unavailable Monday all day"] }));
    expect(await interpretDisruption("Maya sick Monday", state, now)).toMatchObject({ kind: "clarify", source: "gemini", question: "Which Monday?" });
    fetchMock.mockResolvedValue(response(intent({ confidence: 0.1 })));
    expect(await interpretDisruption("Maya sick Monday", state, now)).toMatchObject({ kind: "clarify" });
  });
  it("accepts grounded inclusive multi-day and full-week model windows", async () => {
    fetchMock.mockResolvedValueOnce(response(intent({ throughDay: "wednesday" })));
    expect(await interpretDisruption("Maya unavailable Monday to Wednesday", state, now)).toMatchObject({ source: "gemini", disruption: { from: demoDisruption.from, to: "2026-11-12T05:00:00.000Z" } });
    fetchMock.mockResolvedValueOnce(response(intent({ day: null, thisWeek: true })));
    expect(await interpretDisruption("Maya unavailable this week", state, now)).toMatchObject({ source: "gemini", disruption: { from: demoDisruption.from, to: "2026-11-16T05:00:00.000Z" } });
  });
  it("starts this week on local today without losing later days", () => {
    expect(interpretRules("Maya unavailable this week", state, "2026-11-11T15:00:00Z")).toMatchObject({ disruption: { from: "2026-11-11T05:00:00.000Z", to: "2026-11-16T05:00:00.000Z" } });
  });
  it("bounds the whole provider chain including stalled bodies to 12 seconds", async () => {
    vi.useFakeTimers();
    vi.stubEnv("AI_MODELS", "gemini:deadline-first,groq:deadline-second,gemini:deadline-third");
    vi.stubEnv("GROQ_API_KEY", "test-groq");
    fetchMock.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
    const started = Date.now();
    const pending = interpretDisruption("Maya is sick Monday", state, now);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await pending).toMatchObject({ source: "rules", aiBusy: true, disruption: { instructorId: "instructor-01" } });
    expect(Date.now() - started).toBe(12_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, options]) => options.signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    ["Myaa is sick tomorrow morning", "2026-11-09", 420, 720],
    ["Maya is sick Monday from 2pm to 4pm", "2026-11-09", 840, 960],
    ["Maya is sick Monday from 14:30 to 16:00", "2026-11-09", 870, 960],
    ["Alex not coming tmrw", "2026-11-09", 0, 0],
    ["Maya is down with fever, cancel her Monday classes", "2026-11-09", 0, 0],
    ["Maya is sick Monday after 2pm", "2026-11-09", 840, 0],
  ])("supports local rules for %s", (text, dateKey, fromMinutes, toMinutes) => {
    const result = interpretRules(text, state, now);
    if (result.kind === "clarify") throw new Error(result.question);
    expect(localParts(result.disruption.from, state.studio.timezone)).toMatchObject({ dateKey, minutesOfDay: fromMinutes });
    expect(localParts(result.disruption.to, state.studio.timezone).minutesOfDay).toBe(toMinutes);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("requires relative dates to stay inside the displayed week, and rejects past windows", () => {
    for (const text of ["Maya sick today", "Maya sick tomorrow"]) expect(interpretRules(text, state, "2026-12-03T15:00:00Z")).toMatchObject({ kind: "clarify" });
    expect(interpretRules("Maya sick Monday", state, "2026-11-11T15:00:00Z")).toMatchObject({ kind: "clarify" });
  });
  it("uses studio-local today at midnight and handles a DST day inside its week", () => {
    const dstState = seedStudio(42, "2026-10-26T04:00:00Z");
    const result = interpretRules("Maya sick tomorrow all day", dstState, "2026-11-01T03:30:00Z");
    if (result.kind === "clarify") throw new Error(result.question);
    expect(result.disruption.from).toBe("2026-11-01T04:00:00.000Z");
    expect(result.disruption.to).toBe("2026-11-02T05:00:00.000Z");
  });
});

function messagePlan(): Plan {
  const original = state.sessions[0];
  const before = { instructorId: original.instructorId, roomId: original.roomId, start: original.start, end: original.end };
  return {
    disruption: demoDisruption, now,
    sessionChanges: [{ sessionId: original.id, remedy: "move_time", before, after: {
      ...before, instructorId: "instructor-02", start: "2026-11-10T22:30:00.000Z", end: "2026-11-10T23:30:00.000Z",
    }, reason: "Instructor unavailable" }],
    bookingActions: state.bookings.filter((booking) => booking.sessionId === original.id).slice(0, 3).map((booking, index) => ({
      bookingId: booking.id, customerId: booking.customerId, action: (["keep", "move", "refund"] as const)[index], amount: booking.amount, reason: "Instructor unavailable",
    })),
    totals: { sessionsAffected: 1, kept: 1, moved: 1, refunded: 1, refundAmount: "18.00", revenueKept: "36.00" }, warnings: [],
  };
}

describe("plan explanations and customer messages", () => {
  it("uses totals exclusively for deterministic explanation numbers without fetching", async () => {
    const plan = messagePlan();
    plan.totals = { sessionsAffected: 91, kept: 92, moved: 93, refunded: 94, refundAmount: "95.00", revenueKept: "96.00" };
    const result = await explainPlan(plan, state);
    expect(result.source).toBe("template");
    expect(result.bullets).toHaveLength(4);
    expect(result.bullets[2]).toContain("$95.00");
    expect(result.bullets[3]).toContain("$96.00");
    expect(result.bullets.join(" ")).not.toContain("USD");
    for (const value of Object.values(plan.totals)) expect(result.bullets.join(" ")).toContain(String(value));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects added, changed, omitted and misplaced numbers during optional rephrasing", async () => {
    const plan = messagePlan();
    const template = await explainPlan(plan, state);
    for (const bullets of [
      template.bullets.map((bullet, index) => index === 0 ? `${bullet} 999 extra places.` : bullet),
      template.bullets.map((bullet, index) => index === 2 ? bullet.replace("18.00", "36.00") : bullet),
      template.bullets.map((bullet, index) => index === 0 ? "All set!" : bullet),
      template.bullets.map((bullet, index) => index === 1 ? bullet.replace("1", "-1") : bullet),
      template.bullets.map((bullet, index) => index === 0 ? `${bullet} Two extra classes.` : bullet),
      [...template.bullets].reverse(),
    ]) {
      fetchMock.mockResolvedValue(response({ headline: template.headline, bullets }));
      expect(await explainPlan(plan, state, { rephrase: true })).toEqual(template);
    }
  });
  it("accepts warm rephrasing with unchanged numbers and falls back on outage", async () => {
    const plan = messagePlan();
    const template = await explainPlan(plan, state);
    const bullets = template.bullets.map((bullet) => `Here's the update: ${bullet}`);
    fetchMock.mockResolvedValue(response({ headline: template.headline, bullets }));
    expect(await explainPlan(plan, state, { rephrase: true })).toEqual({ headline: template.headline, bullets, source: "gemini" });
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    expect(await explainPlan(plan, state, { rephrase: true })).toEqual(template);
  });
  it("drafts one deterministic message per action with substitution, local new time and refund amount", () => {
    const plan = messagePlan();
    const messages = draftCustomerMessages(plan, state);
    expect(messages.map(({ customerId }) => customerId)).toEqual(plan.bookingActions.map(({ customerId }) => customerId));
    expect(messages[0].body).toContain("Alex Rivera will be teaching");
    expect(messages[1].body).toContain("Tuesday, November 10, 2026");
    expect(messages[1].body).toContain("5:30 PM EST");
    expect(messages[1].body).toContain("Doesn't work? Reply for a refund.");
    expect(messages[2].body).toContain(`USD ${plan.bookingActions[2].amount}`);
    expect(messages[2].body).toContain(plan.bookingActions[2].reason);
    expect(messages.every(({ subject, body }) => subject.length > 0 && body.includes(state.studio.name))).toBe(true);
    expect(draftCustomerMessages(plan, state)).toEqual(messages);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("produces drafts for actual solver actions", () => {
    const plan = replan(state, demoDisruption, { now });
    expect(draftCustomerMessages(plan, state)).toHaveLength(plan.bookingActions.length);
  });
});

describe("interpretation route", () => {
  let directory: string;
  let id: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "rebook-ai-"));
    vi.stubEnv("DATA_DIR", directory);
    vi.stubEnv("GEMINI_API_KEY", "");
    id = getRepository().createWorkspace(state).id;
    vi.useFakeTimers(); vi.setSystemTime(new Date(now));
  });
  afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); });
  const request = (body: unknown) => new Request("http://localhost/api/workspaces/interpret", { method: "POST", body: JSON.stringify(body) });
  it("interprets without creating a plan or changing state", async () => {
    const result = await interpret(request({ text: "Maya is sick Monday" }), { params: Promise.resolve({ id }) });
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(await result.json()).toMatchObject({ source: "rules", disruption: { instructorId: "instructor-01" } });
    expect(getRepository().listPlans(id)).toEqual([]);
    expect(getRepository().requireWorkspace(id).state).toEqual(state);
  });
  it("passes AI confirmation through the API and rejects planning until explicitly confirmed", async () => {
    vi.setSystemTime(new Date("2026-11-09T05:15:00Z")); vi.stubEnv("GEMINI_API_KEY", "test-key-never-real");
    fetchMock.mockResolvedValue(response(intent({ day: "today" })));
    const parsed = await (await interpret(request({ text: messyCorpus[0].input }), { params: Promise.resolve({ id }) })).json();
    expect(parsed).toMatchObject({ needsConfirmation: true, source: "gemini" });
    for (const body of [{ disruption: parsed.disruption }, { disruption: parsed.disruption, confirmed: false }, { disruption: { ...parsed.disruption, reason: undefined } }]) {
      const result = await propose(request(body), { params: Promise.resolve({ id }) });
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({ error: expect.stringContaining("Confirm") });
      expect(getRepository().listPlans(id)).toEqual([]);
    }
    const confirmed = await propose(request({ disruption: parsed.disruption, confirmed: true }), { params: Promise.resolve({ id }) });
    expect(confirmed.status).toBe(200);
    expect(getRepository().listPlans(id)).toHaveLength(1);
  });
  it("returns a structured clarification without planning for unresolvable text", async () => {
    const result = await interpret(request({ text: "Something happened" }), { params: Promise.resolve({ id }) });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ kind: "clarify", question: expect.stringContaining("Maya Chen"), suggestions: expect.any(Array) });
    expect(getRepository().listPlans(id)).toEqual([]);
  });
  it("validates workspace IDs, body shape, text limits and JSON", async () => {
    for (const body of [{ text: "" }, { text: "  " }, { text: "a".repeat(501) }, { text: "Maya is sick Monday", other: true }, { text: 42 }]) {
      expect((await interpret(request(body), { params: Promise.resolve({ id }) })).status).toBe(400);
    }
    expect((await interpret(request({ text: "Maya is sick Monday" }), { params: Promise.resolve({ id: "bad" }) })).status).toBe(404);
    expect((await interpret(request({ text: "Maya is sick Monday" }), { params: Promise.resolve({ id: "missing123" }) })).status).toBe(404);
    expect((await interpret(new Request("http://localhost", { method: "POST", body: "{" }), { params: Promise.resolve({ id }) })).status).toBe(400);
  });
});
