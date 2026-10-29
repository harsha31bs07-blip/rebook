"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { ClassType } from "@/lib/domain/types";
import { FIELD_LABELS, IMPORT_FIELDS, REQUIRED_FIELDS, type ColumnMapping, type ImportField } from "@/lib/import/fields";
import type { ImportPreview, Source } from "@/lib/import/service";

const TYPES: ClassType[] = ["yoga", "pilates", "spin", "dance", "hiit", "barre"];
const TYPE_LABELS: Record<ClassType, string> = { yoga: "Yoga", pilates: "Pilates", spin: "Spin / cycling", dance: "Dance", hiit: "HIIT / strength", barre: "Barre" };
const SOURCE: Record<Source, string> = { rules: "Matched", ai: "Suggested by AI", you: "Your choice" };
const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney"];
type Choices = { mapping: ColumnMapping; classTypes: Record<string, ClassType> };

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Something went wrong. Please try again.");
  return data;
}

/** Load an export, check every column and class type Rebook read, then create a private studio from it. */
export default function ImportPage() {
  const router = useRouter();
  const [csv, setCsv] = useState(""), [fileName, setFileName] = useState("");
  const [studioName, setStudioName] = useState(""), [timezone, setTimezone] = useState("America/New_York"), [zoneChosen, setZoneChosen] = useState(false);
  const [dateOrder, setDateOrder] = useState<"mdy" | "dmy">("mdy");
  const [preview, setPreview] = useState<ImportPreview>(), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);

  async function read(text: string, choices?: Choices, zone = timezone, order = dateOrder) {
    setBusy("Reading your week…"); setError("");
    try {
      setPreview(await post<ImportPreview>("/api/import/preview", { csv: text, timezone: zone, dateOrder: order, studioName: studioName || undefined, ...choices }));
      if (!choices) requestAnimationFrame(() => heading.current?.focus());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to read this file."); }
    finally { setBusy(""); }
  }
  function load(text: string, name: string) {
    // Until the owner picks one, assume the studio runs on this browser's time zone.
    let zone = timezone;
    if (!zoneChosen) { try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || zone; } catch {} setTimezone(zone); }
    setCsv(text); setFileName(name); setPreview(undefined); void read(text, undefined, zone);
  }
  /** The owner's answers so far: every column and class type shown, with one change applied. */
  function choices(change: { field?: ImportField; header?: string; className?: string; type?: ClassType | "" } = {}): Choices | undefined {
    if (!preview) return undefined;
    const mapping: ColumnMapping = { ...preview.mapping };
    if (change.field) { if (change.header) mapping[change.field] = change.header; else delete mapping[change.field]; }
    const classTypes: Record<string, ClassType> = Object.fromEntries(preview.classes.filter((item) => item.type).map((item) => [item.name, item.type!]));
    if (change.className) { if (change.type) classTypes[change.className] = change.type; else delete classTypes[change.className]; }
    return { mapping, classTypes };
  }
  async function create() {
    const confirmed = choices();
    if (!confirmed) return;
    setBusy("Creating your studio…"); setError("");
    try { const { id } = await post<{ id: string }>("/api/import", { csv, timezone, dateOrder, studioName: studioName || undefined, ...confirmed }); router.push(`/w/${id}`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create the studio."); setBusy(""); }
  }
  async function sample() {
    setBusy("Loading the sample week…");
    try { load(await (await fetch("/samples/sample-week.csv")).text(), "sample-week.csv"); }
    catch { setError("Unable to load the sample."); setBusy(""); }
  }

  return <div className="import-page">
    <section className="import-intro"><p className="eyebrow">Bring your own week</p><h1>Try Rebook on your studio’s real schedule.</h1>
      <p className="landing-description">Export one week of bookings from your booking system as a CSV, one row per booking. Rebook reads it, shows you exactly what it understood, and builds a private copy of your week to rehearse a bad morning on.</p>
      <p className="muted import-privacy">Only column headers and class names are sent to the AI, never customer details. Payments are simulated and customers are never contacted. Demo studios reset when the server restarts.</p></section>

    <section className="import-step" aria-labelledby="step-file"><h2 id="step-file"><span aria-hidden="true">1</span> Your booking export</h2>
      <div className="import-fields">
        <label>CSV file<input type="file" accept=".csv,text/csv" disabled={!!busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then((text) => load(text, file.name)); }} /></label>
        <button type="button" disabled={!!busy} onClick={() => void sample()}>Use a sample week</button>
        <a href="/samples/sample-week.csv" download>Download the sample to see the format</a>
      </div>
      <div className="import-fields">
        <label>Studio name<input value={studioName} maxLength={80} placeholder="Your studio" onChange={(event) => setStudioName(event.target.value)} /></label>
        <label>Time zone<select value={timezone} onChange={(event) => { setTimezone(event.target.value); setZoneChosen(true); if (csv) void read(csv, choices(), event.target.value); }}>
          {[...new Set([timezone, ...ZONES])].map((zone) => <option key={zone} value={zone}>{zone.replace(/_/g, " ")}</option>)}</select></label>
        {preview?.dateOrder?.ambiguous && <label>Dates are written as<select value={dateOrder} disabled={!!busy} onChange={(event) => { const order = event.target.value as "mdy" | "dmy"; setDateOrder(order); if (csv) void read(csv, choices(), timezone, order); }}>
          <option value="mdy">Month/day (09/11 = Sep 11)</option><option value="dmy">Day/month (09/11 = 9 Nov)</option></select></label>}
      </div>
      {fileName && <p className="muted">Loaded {fileName}.</p>}
    </section>

    {busy && <p role="status" className="import-status">{busy}</p>}
    {error && <p role="alert" className="error">{error}</p>}

    {preview && <section className="import-step" aria-labelledby="step-check"><h2 id="step-check" ref={heading} tabIndex={-1}><span aria-hidden="true">2</span> Check what Rebook read</h2>
      {preview.aiUnavailable && <p className="warning">The AI is busy, so only exact column names were matched. Choose the rest below.</p>}
      <div className="import-tables">
        <table className="import-table"><caption>Columns</caption><thead><tr><th scope="col">Rebook needs</th><th scope="col">Your column</th><th scope="col">How</th></tr></thead><tbody>
          {IMPORT_FIELDS.map((field) => <tr key={field}><th scope="row">{FIELD_LABELS[field]}{REQUIRED_FIELDS.includes(field) && <span className="required"> (required)</span>}</th>
            <td><select aria-label={`Column for ${FIELD_LABELS[field]}`} value={preview.mapping[field] ?? ""} disabled={!!busy} onChange={(event) => void read(csv, choices({ field, header: event.target.value }))}>
              <option value="">Not in my file</option>{preview.headers.map((header) => <option key={header} value={header}>{header}</option>)}</select></td>
            <td>{preview.sources[field] && <span className={`source-badge source-${preview.sources[field]}`}>{SOURCE[preview.sources[field]!]}</span>}</td></tr>)}
        </tbody></table>
        <table className="import-table"><caption>Class types</caption><thead><tr><th scope="col">Your class</th><th scope="col">Type</th><th scope="col">How</th></tr></thead><tbody>
          {preview.classes.map((item) => <tr key={item.name}><th scope="row">{item.name}</th>
            <td><select aria-label={`Type for ${item.name}`} value={item.type ?? ""} disabled={!!busy} onChange={(event) => void read(csv, choices({ className: item.name, type: event.target.value as ClassType | "" }))}>
              <option value="">Choose…</option>{TYPES.map((type) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}</select></td>
            <td>{item.source && <span className={`source-badge source-${item.source}`}>{SOURCE[item.source]}</span>}</td></tr>)}
        </tbody></table>
      </div>
      <p className="import-summary"><strong>{preview.summary.classes}</strong> classes · <strong>{preview.summary.instructors}</strong> instructors · <strong>{preview.summary.rooms}</strong> rooms · <strong>{preview.summary.customers}</strong> customers · <strong>{preview.summary.bookings}</strong> bookings{preview.summary.weekOf ? ` · week of ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${preview.summary.weekOf}T00:00:00Z`))}` : ""}</p>
      {preview.errors.length > 0 && <div role="alert" className="error-box import-errors"><strong>Fix these before creating your studio</strong><ul>{preview.errors.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      {preview.warnings.length > 0 && <details className="import-assumptions" open><summary>What Rebook assumed</summary><ul>{preview.warnings.map((item) => <li key={item}>{item}</li>)}</ul></details>}
    </section>}

    {preview && <section className="import-step" aria-labelledby="step-create"><h2 id="step-create"><span aria-hidden="true">3</span> Rehearse a bad morning</h2>
      <p className="muted">Your studio opens in the owner console with examples built from your own instructors and rooms. Review the plan, then approve.</p>
      <button className="primary" disabled={!preview.ready || !!busy} onClick={() => void create()}>{busy === "Creating your studio…" ? busy : "Create my studio"}</button>
    </section>}
  </div>;
}
