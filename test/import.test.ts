import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCsv } from "../lib/import/csv";
import { buildImport, parseClock, parseDate } from "../lib/import/build";
import { ruleClassType, ruleMapping } from "../lib/import/fields";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import { replan } from "../lib/solver/replan";
import { validate } from "../lib/solver/validate";
import { interpretDisruption } from "../lib/ai/interpret";
import { executePlan } from "../lib/executor/executePlan";
import { limits } from "../lib/api/limits";

const ai = vi.hoisted(() => ({ generateJson: vi.fn() }));
vi.mock("../lib/ai/gemini", async (original) => ({ ...(await original<typeof import("../lib/ai/gemini")>()), generateJson: ai.generateJson }));
const { createImportedWorkspace, previewImport } = await import("../lib/import/service");
const { POST: previewPost } = await import("../app/api/import/preview/route");
const { POST: createPost } = await import("../app/api/import/route");

const sample = readFileSync(join(__dirname, "../public/samples/sample-week.csv"), "utf8");
const NOW = new Date("2026-10-29T12:00:00Z"), TZ = "America/New_York";
const sampleMapping = ruleMapping(parseCsv(sample)[0]);
const sampleTypes = { "Sunrise Reformer": "pilates", "Vinyasa Flow": "yoga", "Rhythm Ride": "spin", "Slow Burn": "yoga", "Strength Sculpt": "hiit", "Mat Pilates": "pilates" } as const;
let directory: string, repository: Repository;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rebook-import-")); vi.stubEnv("DATA_DIR", directory);
  repository = getRepository(); limits.reset(); ai.generateJson.mockReset();
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("reading an export", () => {
  it("parses quoted CSV with commas, doubled quotes, newlines, CRLF and a BOM", () => {
    expect(parseCsv("﻿a,b\r\n\"x, y\",\"say \"\"hi\"\"\"\r\n\"two\nlines\",3\n\n")).toEqual([["a", "b"], ["x, y", "say \"hi\""], ["two\nlines", "3"]]);
  });
  it("reads common date and time formats, and rejects impossible ones", () => {
    expect(["2026-11-09", "11/9/2026", "9/11/26".replace("26", "2026"), "25/11/2026", "Nov 9 2026", "9 November 2026", "Mon, Nov 9, 2026", "2026-11-09T07:00:00"].map(parseDate))
      .toEqual(["2026-11-09", "2026-11-09", "2026-09-11", "2026-11-25", "2026-11-09", "2026-11-09", "2026-11-09", "2026-11-09"]);
    expect(["2026-02-30", "13/13/2026", "soon"].map(parseDate)).toEqual([undefined, undefined, undefined]);
    expect(["7:00", "07:30", "7:00 AM", "7am", "7.30pm", "12:00 PM", "12am", "19:45", "2026-11-09 18:15", "2026-11-09T06:30:00-05:00"].map(parseClock))
      .toEqual([420, 450, 420, 420, 1170, 720, 0, 1185, 1095, 390]);
    expect(["7", "25:00", "13pm", ""].map(parseClock)).toEqual([undefined, undefined, undefined, undefined]);
  });
  it("matches a Mindbody-style export's columns by rule and leaves unknown columns alone", () => {
    expect(sampleMapping).toEqual({ class: "Class Name", date: "Class Date", start: "Start Time", end: "End Time", instructor: "Staff", room: "Location",
      capacity: "Capacity", price: "Price Paid", customer_name: "Client Name", customer_email: "Client Email" });
  });
  it("types class names by keyword, specific types first, and leaves the rest to the AI and the owner", () => {
    expect(["Sunrise Reformer", "Rhythm Ride", "Strength Sculpt", "Vinyasa Flow", "Mat Pilates", "Dance Flow", "Barre Burn", "Slow Burn"].map(ruleClassType))
      .toEqual(["pilates", "spin", "hiit", "yoga", "pilates", "dance", "barre", undefined]);
  });
});

describe("building the studio", () => {
  it("builds a valid week from the sample, moving a past week forward and explaining every assumption", () => {
    const result = buildImport(sample, { mapping: sampleMapping, classTypes: sampleTypes, timezone: TZ, studioName: "Harbour Movement Co." }, NOW);
    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({ classes: 15, instructors: 4, rooms: 3, customers: 21, bookings: 67, weekOf: "2026-11-02", shiftedWeeks: 2 });
    const state = result.state!;
    expect(state.studio).toMatchObject({ name: "Harbour Movement Co.", timezone: TZ });
    expect(state.instructors.find((item) => item.name === "Ben Okoro")!.skills.sort()).toEqual(["pilates", "yoga"]);
    // Monday 6:30 AM in New York keeps its local time after the move.
    const reformer = state.sessions.find((item) => item.title === "Sunrise Reformer")!;
    expect(reformer.start).toBe("2026-11-02T11:30:00.000Z"); expect(reformer.price).toBe("28.00");
    expect(state.customers.every((customer) => customer.prefs.availabilityKnown === false && customer.email.endsWith("@example.com"))).toBe(true);
    expect(state.bookings.every((booking) => booking.payment?.simulated)).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/Moved the week of 2026-10-19 to the week of 2026-11-02/);
    expect(result.warnings.join(" ")).toMatch(/simulated.*never contacted/);
  });
  it("blocks the import with row numbers for unreadable rows, overlapping teachers and a second week", () => {
    const header = "Class,Date,Start,Instructor,Room\n";
    expect(buildImport(`${header}Yoga,someday,7:00,Ana,A\nYoga,2026-11-10,7:00,,A\n`, { mapping: ruleMapping(["Class", "Date", "Start", "Instructor", "Room"]), classTypes: { Yoga: "yoga" }, timezone: TZ }, NOW).errors)
      .toEqual(["Row 2: can't read the date \"someday\".", "Row 3: no instructor for Yoga."]);
    const overlap = buildImport(`${header}Yoga,2026-11-10,7:00,Ana,A\nPilates,2026-11-10,7:30,Ana,B\n`, { mapping: ruleMapping(["Class", "Date", "Start", "Instructor", "Room"]), classTypes: { Yoga: "yoga", Pilates: "pilates" }, timezone: TZ }, NOW);
    expect(overlap.state).toBeUndefined(); expect(overlap.errors[0]).toMatch(/^Row 2: Yoga overlaps Pilates \(same instructor, Ana\)/);
    const twoWeeks = buildImport(`${header}Yoga,2026-11-10,7:00,Ana,A\nYoga,2026-11-20,7:00,Ana,A\n`, { mapping: ruleMapping(["Class", "Date", "Start", "Instructor", "Room"]), classTypes: { Yoga: "yoga" }, timezone: TZ }, NOW);
    expect(twoWeeks.errors).toEqual(["Row 3: 2026-11-20 is outside the week of 2026-11-09. Import one week at a time."]);
    expect(buildImport(`${header}Yoga,2026-11-10,7:00,Ana,A\n`, { mapping: { class: "Class" }, classTypes: {}, timezone: TZ }, NOW).errors).toEqual(["Choose a column for: start, instructor."]);
    expect(buildImport(`${header}Yoga,2026-11-10,7:00,Ana,A\n`, { mapping: ruleMapping(["Class", "Date", "Start", "Instructor", "Room"]), classTypes: {}, timezone: "Mars/Olympus" }, NOW).errors).toEqual(["Choose your studio's time zone."]);
  });
});

describe("AI suggestions and privacy", () => {
  it("sends only headers and class names to the AI, keeps rule matches, drops invented answers, and lets the owner override", async () => {
    ai.generateJson.mockResolvedValue({ data: { columns: [{ field: "accepts_substitute", header: "Booking Notes" }, { field: "duration", header: "Made Up" }],
      classes: [{ name: "Slow Burn", type: "yoga" }, { name: "Sunrise Reformer", type: "spin" }, { name: "Invented", type: "yoga" }] }, provider: "gemini", model: "m", latencyMs: 5 });
    const preview = await previewImport({ csv: sample, timezone: TZ }, undefined, NOW);
    const prompt = ai.generateJson.mock.calls[0][0] as string;
    expect(prompt).toContain("Booking Notes"); expect(prompt).toContain("Slow Burn");
    for (const secret of ["@example.com", "Kiran Rao", "$28.00", "10/19/2026", "front row"]) expect(prompt).not.toContain(secret);
    expect(prompt).not.toContain("Vinyasa Flow");
    expect(preview.sources).toMatchObject({ class: "rules", instructor: "rules", accepts_substitute: "ai" }); expect(preview.mapping.duration).toBeUndefined();
    expect(preview.classes.find((item) => item.name === "Slow Burn")).toEqual({ name: "Slow Burn", type: "yoga", source: "ai" });
    expect(preview.classes.find((item) => item.name === "Sunrise Reformer")).toEqual({ name: "Sunrise Reformer", type: "pilates", source: "rules" });
    expect(preview).toMatchObject({ ready: true, aiUnavailable: false, summary: { classes: 15, bookings: 67 } });
    ai.generateJson.mockClear();
    const owner = await previewImport({ csv: sample, timezone: TZ, mapping: { ...preview.mapping, accepts_substitute: undefined }, classTypes: { "Slow Burn": "pilates" } }, undefined, NOW);
    expect(owner.classes.find((item) => item.name === "Slow Burn")).toEqual({ name: "Slow Burn", type: "pilates", source: "you" });
    expect(owner.mapping.accepts_substitute).toBeUndefined(); expect(ai.generateJson).not.toHaveBeenCalled();
  });
  it("still previews when the AI is down, asking the owner to choose what rules could not", async () => {
    const { AiUnavailable } = await import("../lib/ai/gemini");
    ai.generateJson.mockRejectedValue(new AiUnavailable(true));
    const preview = await previewImport({ csv: sample, timezone: TZ }, undefined, NOW);
    expect(preview).toMatchObject({ ready: false, aiUnavailable: true });
    expect(preview.classes.find((item) => item.name === "Slow Burn")).toEqual({ name: "Slow Burn", type: undefined, source: undefined });
    expect(preview.errors).toEqual(['Choose a class type for "Slow Burn" (15 rows).']);
  });
});

describe("an imported studio works end to end", () => {
  it("creates a private studio whose owner can describe a sick instructor, plan, and approve simulated refunds", async () => {
    const { AiUnavailable } = await import("../lib/ai/gemini");
    ai.generateJson.mockRejectedValue(new AiUnavailable(true));
    const { id, summary } = createImportedWorkspace(sample, { mapping: sampleMapping, classTypes: sampleTypes, timezone: TZ, studioName: "Harbour Movement Co." }, repository, NOW);
    expect(summary.bookings).toBe(67);
    const { state } = repository.requireReadyWorkspace(id);
    expect(repository.latestMoneyEvents(id).filter((event) => event.kind === "capture" && event.status === "SIMULATED")).toHaveLength(67);
    const reading = await interpretDisruption("Ana has the flu and can't teach Monday", state, NOW.toISOString());
    expect(reading).toMatchObject({ disruption: { kind: "instructor_unavailable", instructorId: state.instructors.find((item) => item.name === "Ana Torres")!.id } });
    if (reading.kind === "clarify") throw new Error("not understood");
    const plan = replan(state, reading.disruption, { now: NOW.toISOString() });
    expect(validate(state, plan)).toEqual({ ok: true, errors: [] });
    expect(plan.totals.sessionsAffected).toBe(1);
    const stored = repository.createPlan(id, plan);
    await executePlan(id, stored.id, repository, undefined, []);
    expect(repository.getPlan(id, stored.id)!.status).toBe("executed");
  });
  it("refuses cross-site requests and creates through the routes with the owner's confirmed choices", async () => {
    const post = (route: (request: Request) => Promise<Response>, body: unknown, origin?: string) => route(new Request("http://localhost/api/import", { method: "POST",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) }));
    expect((await post(createPost, { csv: sample, timezone: TZ }, "https://evil.example")).status).toBe(403);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    ai.generateJson.mockResolvedValue({ data: { columns: [], classes: [{ name: "Slow Burn", type: "yoga" }] }, provider: "gemini", model: "m", latencyMs: 5 });
    const preview = await (await post(previewPost, { csv: sample, timezone: TZ })).json();
    expect(preview.ready).toBe(true);
    const created = await post(createPost, { csv: sample, timezone: TZ, studioName: "Harbour", mapping: preview.mapping, classTypes: Object.fromEntries(preview.classes.map((item: { name: string; type: string }) => [item.name, item.type])) });
    expect(created.status).toBe(200);
    const { id } = await created.json();
    expect(repository.requireReadyWorkspace(id).state.studio.name).toBe("Harbour");
    expect((await post(createPost, { csv: sample, timezone: TZ, mapping: preview.mapping, classTypes: {} })).status).toBe(422);
  });
});

describe("examples written for each studio", () => {
  it("keeps the seeded demo's scripted examples", async () => {
    const { disruptionExamples } = await import("../lib/ai/examples");
    const { seedStudio } = await import("../lib/seed/seed");
    expect(disruptionExamples(seedStudio())).toEqual(["Maya has the flu and can't teach Monday", "The Cycle Lab AC is broken Wednesday afternoon", "Studio closed Saturday morning for a burst pipe"]);
  });
  it("writes an imported studio's examples from its own people, rooms and days, and the rules alone understand each one", async () => {
    const { disruptionExamples } = await import("../lib/ai/examples");
    const { AiUnavailable } = await import("../lib/ai/gemini");
    ai.generateJson.mockRejectedValue(new AiUnavailable(true));
    const state = buildImport(sample, { mapping: sampleMapping, classTypes: sampleTypes, timezone: TZ }, NOW).state!;
    const examples = disruptionExamples(state);
    expect(examples).toEqual(["Ana has the flu and can't teach Monday", "The Main Studio is unavailable Monday afternoon", "Studio closed Sunday morning for a burst pipe"]);
    const kinds = [];
    for (const text of examples) {
      const reading = await interpretDisruption(text, state, NOW.toISOString());
      if (reading.kind === "clarify") throw new Error(`"${text}" needed a question: ${reading.question}`);
      kinds.push(reading.disruption.kind);
    }
    expect(kinds).toEqual(["instructor_unavailable", "room_unavailable", "closure"]);
  });
});
