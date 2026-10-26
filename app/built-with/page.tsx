import Link from "next/link";
import OpenDemoButton from "../../components/console/open-demo-button";

export const metadata = { title: "How it's built · Rebook", description: "Where PayPal, Bryntum, AG Studio, Gemini and WebMCP power Rebook's recovery desk." };

const bryntum = [
  ["EventDrag", "Move proposed recovery blocks between instructors or rooms; server validation finalizes each drop."],
  ["Date constraints and snapping", "Keep moves inside the studio week, snapped to 15-minute intervals."],
  ["Async drop finalization", "Wait for the adjustment API; invalid moves snap back with a reason."],
  ["Drag and event tooltips", "Explain conflicts and show time, room, occupancy and recovery status."],
  ["Resource time ranges / time ranges", "Hatch instructor and room unavailability; shade whole-studio closures."],
  ["Resource column", "Show daily instructor load and room utilisation, including proposed placements."],
  ["Dependencies", "Draw arrows from original classes to their new times."],
  ["Event rendering", "Original ghosts, recovery highlights, cancelled classes and Adjusted by you badges."],
  ["Keyboard selection", "Enter / Space and Move buttons open the same accessible adjustment dialog."],
  ["Timezone and views", "Studio-local week/day views with instructor and room rows."],
  ["Trial resilience", "An accessible schedule and recovery list remain available if Scheduler cannot render."],
];
const studio = [
  ["Report and pages", "Week overview, Disruptions and Money; saved report state per workspace."],
  ["Layout tools", "Edit report, measured canvas, page padding and widget layout tracks."],
  ["Theming", "studioTheme.withParams applies Rebook colours, typography, grids and chart palette."],
  ["Custom widgets and forms", "Recovery impact, Refund receipts, Week heatmap and Recovery metric; editable mappings and appearance."],
  ["Queries and empty states", "Widgets query workspace data and show clear zero / no-disruption states."],
  ["Cross-filtering", "Heatmap cells filter other widgets by instructor AND day."],
  ["Relational data and formatting", "Eight related tables, numeric currency measures and studio-local dates/times."],
  ["Built-in visualisations", "Values, grids and grouped bar/column charts for revenue, refunds and actions."],
  ["CSV export / PNG download", "CSV on grids and charts; PNG download on charts."],
  ["Studio Agent Framework", "Custom Recovery analyst delegates to built-in Data, Page, Planning and Widget agents."],
  ["Custom tools and tool cards", "Disruption and refund-receipt lookups display friendly expandable results."],
  ["Provider adapter", "Gemini proxy forwards live tool schemas, cancellation and Google thought signatures."],
  ["WebMCP bridge", "Read-only report/schema/widget/query tools follow the current Studio report."],
];

function FeatureTable({ rows }: { rows: string[][] }) {
  return <div className="built-table"><table><thead><tr><th scope="col">Feature</th><th scope="col">Where you see it</th></tr></thead><tbody>{rows.map(([feature, use]) => <tr key={feature}><th scope="row">{feature}</th><td>{use}</td></tr>)}</tbody></table></div>;
}

export default async function BuiltWithPage({ searchParams }: { searchParams: Promise<{ workspace?: string | string[] }> }) {
  const { workspace } = await searchParams;
  const id = typeof workspace === "string" && /^[A-Za-z0-9_-]{10}$/.test(workspace) ? workspace : undefined;
  const flow = (destination: "console" | "booking" | "dashboard", label: string) => id
    ? <Link className="built-flow" href={`/w/${id}${destination === "booking" ? "/book" : destination === "dashboard" ? "/dashboard#recovery-analyst" : ""}`}>{label} →</Link>
    : <OpenDemoButton label={label} destination={destination} />;
  const paypal: [string, string, "console" | "booking", string][] = [
    ["Orders v2 + JS SDK v6", "Customer checkout creates an order on the server. PayPal buttons and hosted card fields collect sandbox approval in the browser.", "booking", "See it: book a class"],
    ["Server-side captures", "The booking capture route verifies the order, amount and class before recording a paid booking; seeded scenario bookings also use sandbox captures.", "booking", "See it: payment receipt"],
    ["Payments v2 refunds", "Approve and refund returns money to the original capture. The ledger and stable PayPal-Request-Id protect retries.", "console", "See it: plan and refund"],
    ["Webhooks + signature verification", "The webhook endpoint verifies PayPal signatures before capture/refund events update the ledger. No unsigned event is trusted.", "console", "See it: refund results"],
    ["Transaction Search", "During demo preparation, Transaction Search checks uncertain seeded capture outcomes before another capture can be considered. Inconclusive evidence stays labelled as a simulated fallback.", "console", "See it: payment preparation"],
    ["PayPal Server SDK · APIMatic", "The APIMatic-generated TypeScript SDK calls Orders, Payments and Transaction Search on the server. Credentials stay server-side.", "console", "See it: recovery desk"],
  ];
  return <main id="main-content" tabIndex={-1} className="agent-ready-page built-with-page">
    <header className="landing-header"><Link href="/" className="wordmark" aria-label="Rebook home"><span className="brand-symbol" aria-hidden="true">r</span>rebook<span className="wordmark-dot">.</span></Link>{id ? <Link href={`/w/${id}`}>Back to your studio →</Link> : <Link href="/">Back to Rebook →</Link>}</header>
    <article>
      <p className="eyebrow">The tools behind a calmer week</p><h1>How Rebook is built</h1>
      <p>From a broken schedule to a reviewed recovery, a sandbox refund and an auditable receipt. Each integration has a job you can try.</p>
      <nav className="built-nav" aria-label="Built with sections">{["PayPal", "Bryntum", "AG Studio", "AI", "WebMCP"].map((name) => <a key={name} href={`#${name.toLowerCase().replaceAll(" ", "-")}`}>{name}</a>)}</nav>
      <section id="paypal"><h2>PayPal</h2><p>Real sandbox payments and refunds; no real money moves. Simulated payments elsewhere in the fictional week are labelled.</p>
        <div className="built-table"><table><thead><tr><th scope="col">API / integration</th><th scope="col">Used in Rebook</th><th scope="col">See it</th></tr></thead><tbody>{paypal.map(([name, use, destination, label]) => <tr key={name}><th scope="row">{name}</th><td>{use}</td><td>{flow(destination, label)}</td></tr>)}</tbody></table></div>
      </section>
      <section id="bryntum"><h2>Bryntum Scheduler</h2><p>The owner reviews and adjusts a proposed recovery on the timetable before approval.</p>{flow("console", "See it: recovery timeline")}<FeatureTable rows={bryntum} /></section>
      <section id="ag-studio"><h2>AG Studio</h2><p>A working report and analyst over the same bookings, captures, refunds and applied recoveries as the console.</p>{flow("dashboard", "See it: Dashboard and Recovery analyst")}<FeatureTable rows={studio} /></section>
      <section id="ai"><h2>AI</h2><FeatureTable rows={[
        ["Gemini interpretation", "Turns owner text into a structured disruption, with a model fallback chain. Our code resolves names and local times against studio data."],
        ["Rules fallback", "If Gemini is busy or unavailable, the local parser takes over and the card says Rules (AI busy)."],
        ["Deterministic solver", "Finds qualified cover and valid moves, checks availability, capacity and conflicts, then calculates every booking action and amount."],
        ["Why money never depends on the model", "AI cannot approve or execute payments. The owner approves a versioned plan; server validation, the ledger and PayPal determine refunds."],
        ["Analyst availability", "Chat explains a Gemini outage in plain language. The dashboard, reports and recovery workflow keep working."],
      ]} /></section>
      <section id="webmcp"><h2>WebMCP</h2><p>Page-scoped tools let a compatible browser assistant inspect the schedule, prepare a recovery preview, select a booking or query Studio. Owner approval and payment confirmation remain human actions.</p><Link className="built-flow" href="/agent-ready">Explore the agent-ready flow →</Link></section>
    </article>
  </main>;
}
