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
function readExport(headers: string[], rows: string[][], dateOrder?: "mdy" | "dmy") {
  const csv = [headers, ...rows].map((row) => row.map((value) => `"${value.replace(/"/g, '""')}"`).join(",")).join("\n");
  return buildImport(csv, { mapping: ruleMapping(headers), classTypes: { Yoga: "yoga" }, timezone: TZ, dateOrder }, NOW);
}
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
      capacity: "Capacity", price: "Price Paid", payment: "Pricing Option", customer_name: "Client Name", customer_email: "Client Email", visitsLeft: "Visits Left", expires: "Pack expires" });
  });
  it("types class names by keyword, specific types first, and leaves the rest to the AI and the owner", () => {
    expect(["Sunrise Reformer", "Rhythm Ride", "Strength Sculpt", "Vinyasa Flow", "Mat Pilates", "Dance Flow", "Barre Burn", "Slow Burn"].map(ruleClassType))
      .toEqual(["pilates", "spin", "hiit", "yoga", "pilates", "dance", "barre", undefined]);
  });
});

describe("building the studio", () => {
  it.each(["20", "20.00", "$20.00", "USD 20", "20.00 USD", "  $20.00  ", "0", "0.29", "1,234.50"])("reads the USD amount %s exactly", (price) => {
    const result = readExport(["Class", "Date", "Start", "Instructor", "Price", "Email"], [["Yoga", "2026-11-09", "07:00", "Ana", price, "one@example.com"]]);
    expect(result.errors).toEqual([]);
    const expected = price.includes("1,234") ? "1234.50" : price === "0" ? "0.00" : price === "0.29" ? "0.29" : "20.00";
    expect(result.state!.studio.currency).toBe("USD");
    expect(result.state!.sessions[0].price).toBe(expected);
    expect(result.state!.bookings[0].amount).toBe(expected);
  });
  it.each(["-15.00", "-15", "(15.00)", "EUR20,00", "EUR 20", "GBP 20", "INR 20", "€20", "£20", "₹20", "â‚¬20", "Â£20", "â‚¹20", "20,00", "1.234,50", "20 dollars", "20.001", "1,23.50", "NaN", "100000"])("blocks the lossy price %s with its row and value", (price) => {
    const result = readExport(["Class", "Date", "Start", "Instructor", "Price"], [["Yoga", "2026-11-09", "07:00", "Ana", price]]);
    expect(result.state).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`Row 2: can't read the price "${price}"`);
    expect(result.errors[0]).toContain("Rebook reads US dollars only");
  });
  it("keeps the empty-price assumption visible", () => {
    const result = readExport(["Class", "Date", "Start", "Instructor", "Price"], [["Yoga", "2026-11-09", "07:00", "Ana", ""]]);
    expect(result.errors).toEqual([]);
    expect(result.state!.sessions[0].price).toBe("20.00");
    expect(result.warnings).toContain("No price: each booking is valued at $20.00.");
  });
  it.each([
    ["2026-11-09T06:00:00Z", "2026-11-09T07:00:00Z", "2026-11-09T06:00:00.000Z", "01:00", "02:00", 1],
    ["2026-11-09T00:30:00+02:00", "2026-11-09T01:30:00+0200", "2026-11-08T22:30:00.000Z", "17:30", "18:30", 0],
    ["2026-11-09T06:00:00-0500", "2026-11-09T07:00:00-05:00", "2026-11-09T11:00:00.000Z", "06:00", "07:00", 1],
  ])("preserves the instant %s in New York", (start, end, instant, open, close, weekday) => {
    const result = readExport(["Class", "Date", "Start", "End", "Instructor"], [["Yoga", "2026-11-09", start, end, "Ana"]]);
    expect(result.errors).toEqual([]);
    expect(result.state!.sessions[0].start).toBe(instant);
    expect(result.state!.sessions[0].end).toBe(new Date(Date.parse(instant) + 3_600_000).toISOString());
    expect(result.state!.studio.openHours[weekday]).toEqual([{ open, close }]);
  });
  it("keeps offset-free date-times studio-local and converts an offset end independently", () => {
    const result = readExport(["Class", "Start", "End", "Instructor"], [["Yoga", "2026-11-09T06:00:00", "2026-11-09T12:00:00Z", "Ana"]]);
    expect(result.errors).toEqual([]);
    expect(result.state!.sessions[0]).toMatchObject({ start: "2026-11-09T11:00:00.000Z", end: "2026-11-09T12:00:00.000Z" });
  });
  it("blocks explicit instants on different local days, invalid dates and seconds that would be lost", () => {
    for (const [start, end] of [["2026-11-09T23:30:00-05:00", "2026-11-10T00:30:00-05:00"], ["2026-02-30T06:00:00Z", "2026-02-30T07:00:00Z"], ["2026-11-09T06:00:01Z", "2026-11-09T07:00:00Z"]]) {
      const result = readExport(["Class", "Start", "End", "Instructor"], [["Yoga", start, end, "Ana"]]);
      expect(result.state).toBeUndefined(); expect(result.errors[0]).toMatch(/^Row 2:/);
    }
  });
  it("asks about ambiguous dates, defaults to month/day, and respects day/month", async () => {
    const headers = ["Class", "Date", "Start", "Instructor"], rows = [["Yoga", "09/11/2026", "07:00", "Ana"]];
    const mdy = readExport(headers, rows), dmy = readExport(headers, rows, "dmy");
    expect(mdy.errors).toEqual([]); expect(dmy.errors).toEqual([]);
    expect(mdy.dateOrder).toEqual({ value: "mdy", ambiguous: true });
    expect(dmy.dateOrder).toEqual({ value: "dmy", ambiguous: true });
    expect(mdy.warnings.join(" ")).toContain("month/day (Sep 11)");
    expect(dmy.warnings.join(" ")).toContain("day/month (9 Nov)");
    expect(dmy.state!.sessions[0].start).toBe("2026-11-09T12:00:00.000Z");
    const csv = "Class,Date,Start,Instructor\nYoga,09/11/2026,07:00,Ana";
    const preview = await previewImport({ csv, timezone: TZ, mapping: ruleMapping(headers), dateOrder: "dmy" }, undefined, NOW);
    expect(preview.dateOrder).toEqual({ value: "dmy", ambiguous: true });
    const { id } = createImportedWorkspace(csv, { mapping: preview.mapping, classTypes: { Yoga: "yoga" }, timezone: TZ, dateOrder: "dmy" }, repository, NOW);
    expect(repository.requireReadyWorkspace(id).state.sessions[0].start).toBe(dmy.state!.sessions[0].start);
  });
  it.each([
    ["23/11/2026", "24/11/2026", "dmy", "mdy"],
    ["11/23/2026", "11/24/2026", "mdy", "dmy"],
  ] as const)("decides one date order from %s despite the owner's other default", (first, second, value, choice) => {
    const result = readExport(["Class", "Date", "Start", "Instructor"], [["Yoga", first, "07:00", "Ana"], ["Yoga", second, "07:00", "Ana"]], choice);
    expect(result.errors).toEqual([]);
    expect(result.dateOrder).toEqual({ value, ambiguous: false });
    expect(result.state!.sessions.map((session) => session.start)).toEqual(["2026-11-23T12:00:00.000Z", "2026-11-24T12:00:00.000Z"]);
    expect(result.warnings.join(" ")).not.toContain("Dates like");
  });
  it("uses a decisive row for the whole file, including earlier ambiguous rows", () => {
    const result = readExport(["Class", "Date", "Start", "Instructor"], [["Yoga", "11/09/2026", "07:00", "Ana"], ["Yoga", "13/09/2026", "07:00", "Ana"]]);
    expect(result.errors).toEqual([]);
    expect(result.dateOrder).toEqual({ value: "dmy", ambiguous: false });
    expect(result.summary.classes).toBe(2);
  });
  it("blocks mixed date orders and names both rows", () => {
    const result = readExport(["Class", "Date", "Start", "Instructor"], [["Yoga", "23/11/2026", "07:00", "Ana"], ["Yoga", "11/24/2026", "07:00", "Ana"]]);
    expect(result.state).toBeUndefined();
    expect(result.errors[0]).toMatch(/Row 2:.*23\/11\/2026.*row 3:.*11\/24\/2026/);
  });
  it("leaves cancelled, waitlisted and removed rows out of bookings but keeps their classes", () => {
    const statuses = ["Cancelled", "canceled", "Late Cancel", "waitlist", "WAITLISTED", "removed", "confirmed", "attended", "", "unusual", "unusual"];
    const result = readExport(["Class", "Date", "Start", "Instructor", "Booking status", "Email"], statuses.map((status, index) => ["Yoga", "2026-11-09", index === 0 ? "09:00" : "07:00", "Ana", status, index < 3 || index === 5 ? "bad email" : `person${index}@example.com`]));
    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({ classes: 2, bookings: 5, customers: 7 });
    expect(result.state?.waitlist).toHaveLength(2);
    expect(result.warnings).toContain("2 waitlisted rows joined their class waitlists.");
    expect(result.warnings).toContain("Left out 3 cancelled and 1 removed rows: they are not bookings.");
    expect(result.warnings.filter((warning) => warning.includes("Unrecognized booking statuses"))).toEqual(['Unrecognized booking statuses were counted as bookings: "unusual".']);
    for (const header of ["status", "booking status", "attendance", "visit status"]) expect(ruleMapping([header])).toEqual({ status: header });
  });
  it("caps the unknown status list at five distinct words", () => {
    const result = readExport(["Class", "Date", "Start", "Instructor", "Status"], ["a", "b", "c", "d", "e", "f"].map((status) => ["Yoga", "2026-11-09", "07:00", "Ana", status]));
    expect(result.errors).toEqual([]);
    expect(result.warnings.find((warning) => warning.includes("Unrecognized"))).toBe('Unrecognized booking statuses were counted as bookings: "a", "b", "c", "d", "e", and more.');
  });
  it("imports waitlist entitlements in row order without consuming class capacity", () => {
    const result = readExport(["Class", "Date", "Start", "Instructor", "Status", "Email", "Payment", "Capacity"], [
      ["Yoga", "2026-11-09", "07:00", "Ana", "waitlisted", "pack@example.com", "10-class pack", "1"],
      ["Yoga", "2026-11-09", "07:00", "Ana", "waitlisted", "member@example.com", "Monthly membership", "1"],
    ]);
    expect(result.errors).toEqual([]);
    expect(result.state?.bookings).toEqual([]);
    expect(result.state?.sessions[0].capacity).toBe(1);
    expect(result.state?.waitlist?.map((entry) => entry.entitlement)).toEqual([{ kind: "pack", name: "10-class pack" }, { kind: "membership", name: "Monthly membership" }]);
    expect(Date.parse(result.state!.waitlist![0].joinedAt)).toBeLessThan(Date.parse(result.state!.waitlist![1].joinedAt));
  });
  it("opens only exported weekdays and explains hours, instructor qualifications and raised capacities", () => {
    const result = readExport(["Class", "Date", "Start", "End", "Instructor", "Capacity", "Email"], [
      ["Yoga", "2026-11-09", "07:00", "08:00", "Ana", "1", "one@example.com"],
      ["Yoga", "2026-11-09", "07:00", "08:00", "Ana", "1", "two@example.com"],
      ["Yoga", "2026-11-11", "19:30", "20:30", "Ana", "4", ""],
    ]);
    expect(result.errors).toEqual([]);
    expect(result.state!.studio.openHours).toEqual({ 0: [], 1: [{ open: "07:00", close: "20:30" }], 2: [], 3: [{ open: "07:00", close: "20:30" }], 4: [], 5: [], 6: [] });
    expect(result.state!.instructors[0].skills).toEqual(["yoga"]);
    expect(result.warnings).toContain("Opening hours aren't in the export: Rebook assumes you open Mon, Wed from 07:00 to 20:30, when your classes run.");
    expect(result.warnings).toContain("Instructors are assumed to teach only the class types they teach this week, and to be free whenever they are not teaching.");
    expect(result.warnings).toContain("Row 2: Yoga has more bookings than its capacity; capacity raised to 2.");
  });
  it("reports at most five individual capacity increases and then says and more", () => {
    const rows = Array.from({ length: 6 }, (_, day) => ["one", "two"].map((name) => ["Yoga", `2026-11-${9 + day}`, "07:00", "Ana", "1", `${name}@example.com`])).flat();
    const result = readExport(["Class", "Date", "Start", "Instructor", "Capacity", "Email"], rows);
    expect(result.errors).toEqual([]);
    expect(result.warnings.filter((warning) => warning.includes("capacity raised to"))).toHaveLength(5);
    expect(result.warnings.join(" ")).toContain("and more");
  });
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
    expect(state.bookings.every((booking) => booking.entitlement ? booking.amount === "0.00" && !booking.payment : booking.payment?.simulated)).toBe(true);
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
    expect(repository.latestMoneyEvents(id).filter((event) => event.kind === "capture" && event.status === "SIMULATED")).toHaveLength(state.bookings.filter((booking) => !booking.entitlement).length);
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
    // The owner's day/month answer for an ambiguous file reaches creation: 02/11/2026 is Monday 2 November, not Wednesday 11 February.
    const ambiguous = "Class,Date,Start,Instructor\nMorning Yoga,02/11/2026,09:00,Ana Lopez\n";
    const dayFirst = await post(createPost, { csv: ambiguous, timezone: TZ, dateOrder: "dmy", mapping: { class: "Class", date: "Date", start: "Start", instructor: "Instructor" }, classTypes: { "Morning Yoga": "yoga" } });
    expect(dayFirst.status).toBe(200);
    const [session] = repository.requireReadyWorkspace((await dayFirst.json()).id).state.sessions;
    expect(new Date(session.start).toLocaleDateString("en-US", { weekday: "long", timeZone: TZ })).toBe("Monday");
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
