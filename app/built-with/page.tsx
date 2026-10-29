import Link from "next/link";
import OpenDemoButton from "../../components/console/open-demo-button";

export const metadata = { title: "How it's built · Rebook", description: "Where PayPal, Bryntum, AG Studio, Gemini and WebMCP power Rebook's recovery desk." };

type FeatureRow = [feature: string, use: string, source: string];

const bryntum: FeatureRow[] = [
  ["EventDrag", "Move proposed recovery blocks between instructors or rooms; server validation finalizes each drop.", "components/console/schedule.tsx#L45-L56"],
  ["Date constraints and snapping", "Keep moves inside the studio week, snapped to 15-minute intervals.", "components/console/schedule.tsx#L29-L70"],
  ["Async drop finalization", "Wait for the adjustment API; invalid moves snap back with a reason.", "components/console/schedule.tsx#L173-L193"],
  ["Undo", "Undo last adjustment restores the previous placement through the same server checks.", "app/api/workspaces/[id]/plans/[planId]/adjust/route.ts#L15-L50"],
  ["Drag and event tooltips", "Explain conflicts and show time, room, occupancy and recovery status.", "components/console/schedule.tsx#L138-L142"],
  ["Resource time ranges / time ranges", "Hatch instructor and room unavailability; shade whole-studio closures.", "lib/client/scheduler-mapping.ts#L147-L165"],
  ["Resource column", "Show daily instructor load and room utilisation, including proposed placements.", "components/console/schedule.tsx#L143-L153"],
  ["Dependencies", "Draw arrows from original classes to their new times.", "lib/client/scheduler-mapping.ts#L136-L146"],
  ["Event rendering", "Original ghosts, recovery highlights, cancelled classes and Adjusted by you badges.", "lib/client/scheduler-mapping.ts#L112-L167"],
  ["Keyboard selection", "Enter / Space and Move buttons open the same accessible adjustment dialog.", "components/console/schedule.tsx#L194-L198"],
  ["Timezone and views", "Studio-local week/day views with instructor and room rows.", "components/console/schedule.tsx#L29-L70"],
  ["Trial resilience", "An accessible schedule and recovery list remain available if Scheduler cannot render.", "components/console/schedule-boundary.tsx#L6-L11"],
];
const studio: FeatureRow[] = [
  ["Report and pages", "Week overview, Disruptions and Money; saved report state per workspace.", "components/insights/studio-report.tsx#L39-L54"],
  ["Layout tools", "Edit report, measured canvas, page padding and widget layout tracks.", "lib/insights/report.ts#L4-L8"],
  ["Theming", "studioTheme.withParams applies Rebook colours, typography, grids and chart palette.", "lib/insights/theme.ts#L3-L19"],
  ["Custom widgets and forms", "Recovery impact, Refund receipts, Week heatmap and Recovery metric; editable mappings and appearance.", "components/insights/widgets.tsx#L166-L203"],
  ["Queries and empty states", "Widgets query workspace data and show clear zero / no-disruption states.", "components/insights/widgets.tsx#L25-L42"],
  ["Cross-filtering", "Heatmap cells filter other widgets by instructor AND day.", "components/insights/widgets.tsx#L50-L77"],
  ["Relational data and formatting", "Eight related tables, numeric currency measures and studio-local dates/times.", "lib/insights/studio-data.ts#L34-L61"],
  ["Built-in visualisations", "Values, grids and grouped bar/column charts for revenue, refunds and actions.", "lib/insights/report.ts#L25-L52"],
  ["CSV export / PNG download", "CSV on grids and charts; PNG download on charts.", "components/insights/widgets.tsx#L180-L203"],
  ["Studio Agent Framework", "Custom Recovery analyst answers common questions with direct tools and preset charts, and delegates custom report edits to built-in Data, Page, Planning and Widget agents.", "lib/insights/ai.ts#L124-L138"],
  ["Custom tools and tool cards", "Disruption and refund-receipt lookups display friendly expandable results.", "lib/insights/ai.ts#L66-L84"],
  ["Tool card rendering", "Expand a lookup result to inspect its disruption or refund receipt details.", "components/insights/tool-cards.tsx#L27-L39"],
  ["Provider adapter", "Gemini proxy forwards live tool schemas, cancellation and Google thought signatures.", "lib/insights/gemini-adapter.ts#L88-L144"],
  ["WebMCP bridge", "Read-only report/schema/widget/query tools follow the current Studio report.", "lib/webmcp/studio.ts#L4-L23"],
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
    ["PayPal Agent Toolkit: read-only Verify with PayPal", "Compare recorded refunds with PayPal through the Agent Toolkit; cover fees are checked through the Payouts API. Verification never changes the ledger.", "console", "See it: Verify with PayPal", "lib/paypal/verify.ts#L19-L30"],
    ["Orders v2 + JS SDK v6", "Customer checkout creates an order on the server. PayPal buttons and hosted card fields collect sandbox approval in the browser.", "booking", "See it: book a class", "components/booking/booking-page.tsx#L124-L167"],
    ["Server-side captures", "The booking capture route verifies the order, amount and class before recording a paid booking; seeded scenario bookings also use sandbox captures.", "booking", "See it: payment receipt", "lib/checkout/service.ts#L176-L203"],
    ["Payments v2 refunds", "Approve and refund returns money to the original capture. The ledger and stable PayPal-Request-Id protect retries.", "console", "See it: plan and refund", "lib/paypal/client.ts#L257-L263"],
    ["Payouts", "After a substitute accepts on their cover link, the owner pays the cover fee with a PayPal payout. The request id doubles as the batch id, so a lost response replays the same payout.", "console", "See it: cover instructors", "lib/recovery/cover-pay.ts#L116-L156"],
    ["Ask the next instructor", "If the substitute says no, the console names the next qualified instructor who is free then and suits everyone booked; one click gives them the class and their own cover link, and the payout follows whoever teaches.", "console", "See it: cover instructors", "lib/recovery/cover-pay.ts#L66-L97"],
    ["Webhooks + signature verification", "The webhook endpoint verifies PayPal signatures before capture/refund events update the ledger. No unsigned event is trusted.", "console", "See it: refund results", "app/api/paypal/webhook/route.ts#L6-L48"],
    ["Transaction Search", "During demo preparation, Transaction Search checks uncertain seeded capture outcomes after the idempotency window expires. Inconclusive evidence stays labelled as a simulated fallback.", "console", "See it: payment preparation", "lib/demo/createWorkspace.ts#L66-L106"],
    ["PayPal Server SDK · APIMatic", "The APIMatic-generated TypeScript SDK calls Orders, Payments and Transaction Search on the server. Credentials stay server-side.", "console", "See it: recovery desk", "lib/paypal/client.ts#L27-L68"],
  ];
  return <main id="main-content" tabIndex={-1} className="agent-ready-page built-with-page">
    <header className="landing-header"><Link href="/" className="wordmark"><span className="brand-symbol" aria-hidden="true">r</span>rebook<span className="wordmark-dot">.</span><span className="sr-only"> home</span></Link>{id ? <Link href={`/w/${id}`}>Back to your studio →</Link> : <Link href="/">Back to Rebook →</Link>}</header>
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
        ["AI providers", "Gemini first; Groq takes small requests when Gemini is busy", "lib/ai/studio-transport.ts#L11-L26"],
        ["Disruption interpretation", "Turns owner text into a structured disruption. Our code resolves names and local times against studio data.", "lib/ai/interpret.ts#L346-L366"],
        ["Messy messages", "Reads forwarded texts, Hinglish and shorthand the rules cannot. Negations, maybes and corrections never reach the model, its reading must match your words, and you confirm it before planning.", "lib/ai/interpret.ts#L249-L294"],
        ["Customer assistant", "On a private link, turns \"anything after 6, otherwise refund me\" into one real option for the customer to confirm. Amounts and money wording come from the server.", "lib/choices/assistant.ts#L18-L59"],
        ["Bring your own week", "Reads a booking-system export at /import. Exact-name rules match what they can; the AI suggests the remaining columns and class types from headers and class names only, never customer details. The owner sees how each match was made and confirms it.", "lib/import/service.ts#L22-L53"],
        ["Rules fallback", "If AI is busy or unavailable, the local parser takes over and the card says Rules (AI busy).", "lib/ai/interpret.ts#L346-L366"],
        ["Deterministic solver", "Finds qualified cover and valid moves, checks availability, capacity and conflicts, then calculates every booking action and amount. When a quick first pass is not provably best, a bounded search tries other assignments; if it still cannot prove no plan keeps more bookings, the plan says so. Tests compare it with a brute-force search.", "lib/solver/replan.ts#L235-L272"],
        ["Why money never depends on the model", "AI cannot approve or execute payments. The owner approves a versioned plan; server validation, the ledger and PayPal determine refunds.", "lib/executor/executePlan.ts#L39-L59"],
        ["Analyst availability", "Chat explains a provider outage in plain language. The dashboard, reports and recovery workflow keep working.", "lib/insights/gemini-adapter.ts#L88-L144"],
      ]} /></section>
      <section id="webmcp"><h2>WebMCP</h2><p>Page-scoped tools let a compatible browser assistant inspect the schedule, prepare a recovery preview, select a booking or query Studio. Owner approval and payment confirmation remain human actions.</p><Link className="built-flow" href="/agent-ready">Explore the agent-ready flow →</Link><br /><CodeLink source="lib/webmcp/studio.ts#L4-L23" /></section>
    </article>
  </main>;
}
