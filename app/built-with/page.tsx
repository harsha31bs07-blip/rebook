import Link from "next/link";
import OpenDemoButton from "../../components/console/open-demo-button";

export const metadata = { title: "How it's built · Rebook", description: "Where PayPal, Bryntum, AG Studio, Gemini and WebMCP power Rebook's recovery desk." };

type FeatureRow = [feature: string, use: string, source: string];

const bryntum: FeatureRow[] = [
  ["EventDrag", "Move proposed recovery blocks between instructors or rooms; server validation finalizes each drop.", "components/console/schedule.tsx#L44-L57"],
  ["Date constraints and snapping", "Keep moves inside the studio week, snapped to 15-minute intervals.", "components/console/schedule.tsx#L29-L44"],
  ["Async drop finalization", "Wait for the adjustment API; invalid moves snap back with a reason.", "components/console/schedule.tsx#L166-L193"],
  ["Undo", "Undo last adjustment restores the previous placement through the same server checks.", "app/api/workspaces/[id]/plans/[planId]/adjust/route.ts#L23-L48"],
  ["Drag and event tooltips", "Explain conflicts and show time, room, occupancy and recovery status.", "components/console/schedule.tsx#L47-L55"],
  ["Resource time ranges / time ranges", "Hatch instructor and room unavailability; shade whole-studio closures.", "lib/client/scheduler-mapping.ts#L146-L165"],
  ["Resource column", "Show daily instructor load and room utilisation, including proposed placements.", "components/console/schedule.tsx#L136-L146"],
  ["Dependencies", "Draw arrows from original classes to their new times.", "lib/client/scheduler-mapping.ts#L136-L144"],
  ["Event rendering", "Original ghosts, recovery highlights, cancelled classes and Adjusted by you badges.", "lib/client/scheduler-mapping.ts#L118-L165"],
  ["Keyboard selection", "Enter / Space and Move buttons open the same accessible adjustment dialog.", "components/console/schedule.tsx#L152-L162"],
  ["Timezone and views", "Studio-local week/day views with instructor and room rows.", "components/console/schedule.tsx#L29-L44"],
  ["Trial resilience", "An accessible schedule and recovery list remain available if Scheduler cannot render.", "components/console/schedule-boundary.tsx#L7-L30"],
];
const studio: FeatureRow[] = [
  ["Report and pages", "Week overview, Disruptions and Money; saved report state per workspace.", "components/insights/studio-report.tsx#L38-L56"],
  ["Layout tools", "Edit report, measured canvas, page padding and widget layout tracks.", "lib/insights/report.ts#L4-L19"],
  ["Theming", "studioTheme.withParams applies Rebook colours, typography, grids and chart palette.", "lib/insights/theme.ts#L3-L19"],
  ["Custom widgets and forms", "Recovery impact, Refund receipts, Week heatmap and Recovery metric; editable mappings and appearance.", "components/insights/widgets.tsx#L176-L188"],
  ["Queries and empty states", "Widgets query workspace data and show clear zero / no-disruption states.", "components/insights/widgets.tsx#L25-L47"],
  ["Cross-filtering", "Heatmap cells filter other widgets by instructor AND day.", "components/insights/widgets.tsx#L50-L76"],
  ["Relational data and formatting", "Eight related tables, numeric currency measures and studio-local dates/times.", "lib/insights/studio-data.ts#L8-L42"],
  ["Built-in visualisations", "Values, grids and grouped bar/column charts for revenue, refunds and actions.", "lib/insights/report.ts#L25-L51"],
  ["CSV export / PNG download", "CSV on grids and charts; PNG download on charts.", "components/insights/widgets.tsx#L190-L198"],
  ["Studio Agent Framework", "Custom Recovery analyst delegates to built-in Data, Page, Planning and Widget agents.", "lib/insights/ai.ts#L73-L87"],
  ["Custom tools and tool cards", "Disruption and refund-receipt lookups display friendly expandable results.", "lib/insights/ai.ts#L54-L72"],
  ["Tool card rendering", "Expand a lookup result to inspect its disruption or refund receipt details.", "components/insights/tool-cards.tsx#L14-L42"],
  ["Provider adapter", "Gemini proxy forwards live tool schemas, cancellation and Google thought signatures.", "lib/insights/gemini-adapter.ts#L11-L101"],
  ["WebMCP bridge", "Read-only report/schema/widget/query tools follow the current Studio report.", "lib/webmcp/studio.ts#L5-L21"],
];

function CodeLink({ source }: { source: string }) {
  return <small><a href={`https://github.com/harsha31bs07-blip/rebook/blob/main/${source}`} target="_blank" rel="noreferrer">View code: {source.split("#")[0]}</a></small>;
}

function FeatureTable({ rows }: { rows: FeatureRow[] }) {
  return <div className="built-table"><table><thead><tr><th scope="col">Feature</th><th scope="col">Where you see it</th></tr></thead><tbody>{rows.map(([feature, use, source]) => <tr key={feature}><th scope="row">{feature}</th><td>{use}<br /><CodeLink source={source} /></td></tr>)}</tbody></table></div>;
}

export default async function BuiltWithPage({ searchParams }: { searchParams: Promise<{ workspace?: string | string[] }> }) {
  const { workspace } = await searchParams;
  const id = typeof workspace === "string" && /^[A-Za-z0-9_-]{10}$/.test(workspace) ? workspace : undefined;
  const flow = (destination: "console" | "booking" | "dashboard", label: string) => id
    ? <Link className="built-flow" href={`/w/${id}${destination === "booking" ? "/book" : destination === "dashboard" ? "/dashboard#recovery-analyst" : ""}`}>{label} →</Link>
    : <OpenDemoButton label={label} destination={destination} />;
  const paypal: [string, string, "console" | "booking", string, string][] = [
    ["Orders v2 + JS SDK v6", "Customer checkout creates an order on the server. PayPal buttons and hosted card fields collect sandbox approval in the browser.", "booking", "See it: book a class", "components/booking/booking-page.tsx#L74-L168"],
    ["Server-side captures", "The booking capture route verifies the order, amount and class before recording a paid booking; seeded scenario bookings also use sandbox captures.", "booking", "See it: payment receipt", "lib/checkout/service.ts#L84-L118"],
    ["Payments v2 refunds", "Approve and refund returns money to the original capture. The ledger and stable PayPal-Request-Id protect retries.", "console", "See it: plan and refund", "lib/paypal/client.ts#L257-L263"],
    ["Webhooks + signature verification", "The webhook endpoint verifies PayPal signatures before capture/refund events update the ledger. No unsigned event is trusted.", "console", "See it: refund results", "app/api/paypal/webhook/route.ts#L23-L38"],
    ["Transaction Search", "During demo preparation, Transaction Search checks uncertain seeded capture outcomes after the idempotency window expires. Inconclusive evidence stays labelled as a simulated fallback.", "console", "See it: payment preparation", "lib/demo/createWorkspace.ts#L76-L107"],
    ["PayPal Server SDK · APIMatic", "The APIMatic-generated TypeScript SDK calls Orders, Payments and Transaction Search on the server. Credentials stay server-side.", "console", "See it: recovery desk", "lib/paypal/client.ts#L27-L69"],
  ];
  return <main id="main-content" tabIndex={-1} className="agent-ready-page built-with-page">
    <header className="landing-header"><Link href="/" className="wordmark" aria-label="Rebook home"><span className="brand-symbol" aria-hidden="true">r</span>rebook<span className="wordmark-dot">.</span></Link>{id ? <Link href={`/w/${id}`}>Back to your studio →</Link> : <Link href="/">Back to Rebook →</Link>}</header>
    <article>
      <p className="eyebrow">The tools behind a calmer week</p><h1>How Rebook is built</h1>
      <p>From a broken schedule to a reviewed recovery, a sandbox refund and an auditable receipt. Each integration has a job you can try.</p>
      <nav className="built-nav" aria-label="Built with sections">{["PayPal", "Bryntum", "AG Studio", "AI", "WebMCP"].map((name) => <a key={name} href={`#${name.toLowerCase().replaceAll(" ", "-")}`}>{name}</a>)}</nav>
      <section id="paypal"><h2>PayPal</h2><p>Real sandbox payments and refunds; no real money moves. Simulated payments elsewhere in the fictional week are labelled.</p>
        <div className="built-table"><table><thead><tr><th scope="col">API / integration</th><th scope="col">Used in Rebook</th><th scope="col">See it</th></tr></thead><tbody>{paypal.map(([name, use, destination, label, source]) => <tr key={name}><th scope="row">{name}</th><td>{use}<br /><CodeLink source={source} /></td><td>{flow(destination, label)}</td></tr>)}</tbody></table></div>
        <p>The PayPal context plugin&apos;s TypeScript skills for client initialization, calling endpoints and error handling guided the migration to the APIMatic-generated SDK. PaymentsController also reads captures and refunds during reconciliation.</p>
        <p>Server SDK 2.5.0 has no webhook signature verification endpoint. That call and its OAuth exchange use fetch with a separate bounded retry wrapper; Orders, Payments and Transaction Search use the SDK&apos;s retry configuration. <CodeLink source="lib/paypal/client.ts#L286-L296" /></p>
      </section>
      <section id="bryntum"><h2>Bryntum Scheduler</h2><p>Rebook&apos;s solver does the re-planning. Bryntum Scheduler is the interactive review surface: the owner checks and adjusts the proposed recovery before approval.</p>{flow("console", "See it: recovery timeline")}<FeatureTable rows={bryntum} /></section>
      <section id="ag-studio"><h2>AG Studio</h2><p>A working report and analyst over the same bookings, captures, refunds and applied recoveries as the console.</p>{flow("dashboard", "See it: Dashboard and Recovery analyst")}<FeatureTable rows={studio} /></section>
      <section id="ai"><h2>AI</h2><FeatureTable rows={[
        ["Gemini interpretation", "Turns owner text into a structured disruption, with a model fallback chain. Our code resolves names and local times against studio data.", "lib/ai/interpret.ts#L170-L192"],
        ["Rules fallback", "If Gemini is busy or unavailable, the local parser takes over and the card says Rules (AI busy).", "lib/ai/interpret.ts#L170-L192"],
        ["Deterministic solver", "Finds qualified cover and valid moves, checks availability, capacity and conflicts, then calculates every booking action and amount.", "lib/solver/replan.ts#L28-L90"],
        ["Why money never depends on the model", "AI cannot approve or execute payments. The owner approves a versioned plan; server validation, the ledger and PayPal determine refunds.", "lib/executor/executePlan.ts#L10-L41"],
        ["Analyst availability", "Chat explains a Gemini outage in plain language. The dashboard, reports and recovery workflow keep working.", "lib/insights/gemini-adapter.ts#L11-L101"],
      ]} /></section>
      <section id="webmcp"><h2>WebMCP</h2><p>Page-scoped tools let a compatible browser assistant inspect the schedule, prepare a recovery preview, select a booking or query Studio. Owner approval and payment confirmation remain human actions.</p><Link className="built-flow" href="/agent-ready">Explore the agent-ready flow →</Link><br /><CodeLink source="lib/webmcp/studio.ts#L5-L21" /></section>
    </article>
  </main>;
}
