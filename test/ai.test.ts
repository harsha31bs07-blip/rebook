import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AiUnavailable, generateJson } from "../lib/ai/gemini";
import { InterpretationError, interpretDisruption } from "../lib/ai/interpret";
import { explainPlan } from "../lib/ai/explain";
import { draftCustomerMessages } from "../lib/ai/messages";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { localParts } from "../lib/domain/time";
import type { Plan } from "../lib/domain/types";
import { POST as interpret } from "../app/api/workspaces/[id]/interpret/route";
import { closeRepository, getRepository } from "../lib/store";

const now = "2026-11-08T15:00:00Z";
const state = seedStudio();
const weekStart = "2026-11-09T05:00:00.000Z";
const objectSchema = { type: "OBJECT", properties: { ok: { type: "BOOLEAN" } }, required: ["ok"] };
const OkSchema = z.object({ ok: z.boolean() });
const response = (data: unknown) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }] });
const intent = (overrides: Record<string, unknown> = {}) => ({
  kind: "instructor_unavailable", name: "Maya Chen", day: "monday", untilDay: null,
  startTime: null, endTime: null, period: "all_day", thisWeek: false, confidence: 0.95, notes: [], ...overrides,
});
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "test-key-never-real");
  vi.stubEnv("GEMINI_MODELS", "first,second,third");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("Gemini JSON generation", () => {
  it("tries models in env order after 503 and sends JSON schema without logging secrets", async () => {
    const log = vi.spyOn(console, "error");
    fetchMock.mockResolvedValueOnce(new Response("high demand", { status: 503 })).mockResolvedValueOnce(response({ ok: true }));
    const result = await generateJson("test prompt", objectSchema, OkSchema);
    expect(result).toMatchObject({ data: { ok: true }, model: "second" });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/v1beta/models/first:generateContent", "/v1beta/models/second:generateContent",
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig).toEqual({ responseMimeType: "application/json", responseSchema: objectSchema });
    expect(log).not.toHaveBeenCalled();
  });
  it("aborts a hung request after 12 seconds and tries the next model", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(response({ ok: true }));
    const pending = generateJson("test", objectSchema, OkSchema);
    await vi.advanceTimersByTimeAsync(12_000);
    expect((await pending).model).toBe("second");
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("limits all models and stalled response bodies to a shared 25 second budget", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
    const outcome = generateJson("test", objectSchema, OkSchema).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await outcome).toBeInstanceOf(AiUnavailable);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([, opts]) => opts.signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects malformed JSON and zod-invalid output before accepting a valid model", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }))
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
  it.each([
    ["Maya is sick Monday", "instructor_unavailable", "instructor-01", "2026-11-09T05:00:00.000Z", "2026-11-10T05:00:00.000Z"],
    ["Maya has the flu, out until Wednesday", "instructor_unavailable", "instructor-01", "2026-11-08T05:00:00.000Z", "2026-11-11T05:00:00.000Z"],
    ["Cycle Lab AC broken Wed afternoon", "room_unavailable", "room-03", "2026-11-11T17:00:00.000Z", "2026-11-11T22:00:00.000Z"],
    ["studio closed Saturday for a burst pipe", "closure", null, "2026-11-14T05:00:00.000Z", "2026-11-15T05:00:00.000Z"],
    ["Alex can't do evenings this week", "instructor_unavailable", "instructor-02", "2026-11-09T22:00:00.000Z", "2026-11-10T02:00:00.000Z"],
  ])("resolves %s with rules when every model is unavailable", async (text, kind, id, from, to) => {
    fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));
    const result = await interpretDisruption(text!, state, now, weekStart);
    expect(result).toMatchObject({ source: "rules", disruption: { kind, from, to, reason: text } });
    if (result.disruption.kind === "instructor_unavailable") expect(result.disruption.instructorId).toBe(id);
    if (result.disruption.kind === "room_unavailable") expect(result.disruption.roomId).toBe(id);
    if (text!.includes("this week")) expect(result.notes.join(" ")).toContain("first affected");
    if (text!.includes("until")) expect(result.notes.join(" ")).toContain("availability resumes");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it.each(["2026-12-03T15:00:00Z", "2026-12-06T15:00:00Z", "2026-12-07T15:00:00Z"])("keeps weekdays inside the seeded week when now is %s", async (clock) => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const week = "2026-12-07T05:00:00.000Z";
    const december = seedStudio(42, week);
    for (const [text, date, minutes] of [
      ["Maya has the flu Monday", "2026-12-07", 0],
      ["Cycle Lab is broken Wednesday afternoon", "2026-12-09", 720],
      ["studio closed Saturday", "2026-12-12", 0],
    ] as const) {
      const result = await interpretDisruption(text, december, clock, week);
      expect(localParts(result.disruption.from, december.studio.timezone)).toMatchObject({ dateKey: date, minutesOfDay: minutes });
    }
  });
  it("keeps today and tomorrow relative to now and notes empty windows for rules and Gemini", async () => {
    for (const source of ["rules", "gemini"] as const) {
      vi.stubEnv("GEMINI_API_KEY", source === "rules" ? "" : "test-key");
      for (const [day, date] of [["today", "2026-12-03"], ["tomorrow", "2026-12-04"]] as const) {
        fetchMock.mockResolvedValue(response(intent({ day })));
        const result = await interpretDisruption(`Maya is sick ${day}`, state, "2026-12-03T15:00:00Z", weekStart);
        expect(result.source).toBe(source);
        expect(localParts(result.disruption.from, state.studio.timezone).dateKey).toBe(date);
        expect(result.notes).toContain("No classes are scheduled then");
      }
    }
  });
  it("resolves model names and local clocks itself, ignoring model-made IDs and instants", async () => {
    fetchMock.mockImplementation(async () => response(intent({ instructorId: "attacker-id", from: "1900-01-01T00:00:00Z", to: "2099-01-01T00:00:00Z" })));
    const result = await interpretDisruption("Maya is sick Monday", state, now, weekStart);
    expect(result).toMatchObject({ source: "gemini", model: "first", disruption: {
      instructorId: "instructor-01", from: "2026-11-09T05:00:00.000Z", to: "2026-11-10T05:00:00.000Z",
    } });
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).contents[0].parts[0].text;
    expect(prompt).toContain("2026-11-08, sunday");
    expect(prompt).toContain("America/New_York");
    expect(prompt).toContain("Maya Chen");
    expect(prompt).toContain("Cycle Lab");
    expect(prompt).toContain("2026-11-09 monday");
  });
  it("falls back to rules for unknown model names and rejects unknown owner names", async () => {
    fetchMock.mockImplementation(async () => response(intent({ name: "Beatrice Unknown" })));
    expect((await interpretDisruption("Maya is sick Monday", state, now, weekStart)).source).toBe("rules");
    await expect(interpretDisruption("Beatrice is sick Monday", state, now, weekStart)).rejects.toBeInstanceOf(InterpretationError);
  });
  it("rejects hallucinated known resources that are absent from the text", async () => {
    fetchMock.mockImplementation(async () => response(intent()));
    await expect(interpretDisruption("Beatrice is sick Monday", state, now, weekStart)).rejects.toThrow("Maya Chen");
  });
  it("does not widen an instructor absence into a hallucinated studio closure", async () => {
    fetchMock.mockImplementation(async () => response(intent({ kind: "closure", name: null })));
    expect((await interpretDisruption("Maya is sick Monday", state, now, weekStart)).disruption.kind).toBe("instructor_unavailable");
  });
  it("rejects low-confidence ambiguous inputs with helpful known names", async () => {
    fetchMock.mockImplementation(async () => response(intent({ confidence: 0.1 })));
    await expect(interpretDisruption("Something happened", state, now, weekStart)).rejects.toThrow("Cycle Lab");
    await expect(interpretDisruption("Maya is sick Monday", state, now, weekStart)).rejects.toBeInstanceOf(InterpretationError);
    await expect(interpretDisruption("Maya and Alex are sick Monday", state, now, weekStart)).rejects.toBeInstanceOf(InterpretationError);
  });
  it.each([
    ["Myaa is sick tomorrow morning", "2026-11-09", 420, 720],
    ["Maya is sick today evening", "2026-11-08", 1020, 1260],
    ["Maya is sick Monday from 2pm to 4pm", "2026-11-09", 840, 960],
    ["Maya is sick Monday from 14:30 to 16:00", "2026-11-09", 870, 960],
  ])("supports local rules for %s", async (text, dateKey, fromMinutes, toMinutes) => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const { disruption } = await interpretDisruption(text, state, now, weekStart);
    expect(localParts(disruption.from, state.studio.timezone)).toMatchObject({ dateKey, minutesOfDay: fromMinutes });
    expect(localParts(disruption.to, state.studio.timezone).minutesOfDay).toBe(toMinutes);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uses the studio-local day near midnight and converts across DST locally", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const { disruption } = await interpretDisruption("Maya is sick tomorrow all day", state, "2026-11-01T03:30:00Z", weekStart);
    expect(disruption.from).toBe("2026-11-01T04:00:00.000Z");
    expect(disruption.to).toBe("2026-11-02T05:00:00.000Z");
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
  it("returns 422 and helpful names for unresolvable text", async () => {
    const result = await interpret(request({ text: "Something happened" }), { params: Promise.resolve({ id }) });
    expect(result.status).toBe(422);
    expect((await result.json()).error).toContain("Maya Chen");
  });
  it("validates workspace IDs, body shape, text limits and JSON", async () => {
    for (const body of [{ text: "" }, { text: "  " }, { text: "a".repeat(501) }, { text: "Maya is sick Monday", other: true }, { text: 42 }]) {
      expect((await interpret(request(body), { params: Promise.resolve({ id }) })).status).toBe(400);
    }
    expect((await interpret(request({ text: "Maya is sick Monday" }), { params: Promise.resolve({ id: "bad" }) })).status).toBe(400);
    expect((await interpret(request({ text: "Maya is sick Monday" }), { params: Promise.resolve({ id: "missing123" }) })).status).toBe(404);
    expect((await interpret(new Request("http://localhost", { method: "POST", body: "{" }), { params: Promise.resolve({ id }) })).status).toBe(400);
  });
});
