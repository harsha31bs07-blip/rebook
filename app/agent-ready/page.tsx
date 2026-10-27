import Link from "next/link";

export default function AgentReadyPage() {
  return <main id="main-content" tabIndex={-1} className="agent-ready-page">
    <header className="landing-header"><Link href="/" className="wordmark">rebook<span className="wordmark-dot">.</span><span className="sr-only"> home</span></Link><Link href="/">Back to Rebook</Link></header>
    <article>
      <p className="eyebrow">Agent-ready with WebMCP</p>
      <h1>Assistants prepare.<br />Humans approve money.</h1>
      <p>Rebook publishes structured tools to compatible browser assistants. An assistant can read your week, prepare a recovery preview, or select a class. You see the result in the same interface you use yourself.</p>
      <h2>You make the call</h2>
      <p>A recovery preview does not change your schedule or issue refunds. Only the owner’s click on <strong>Approve and refund</strong> applies the plan and starts refunds. An assistant’s approval request displays “An assistant prepared this plan. Review and approve.”</p>
      <p>For a booking, an assistant can select a class and prefill your name and email. You must approve payment through PayPal or the hosted card checkout. Assistants never need your payment credentials.</p>
      <h2>Tools on each page</h2>
      <dl>
        <dt>Owner console</dt><dd><code>get_week_schedule</code> reads local class times, instructors, rooms and occupancy. <code>report_disruption</code> interprets your text and shows a plan preview. <code>get_plan_summary</code> reads counts and money amounts. <code>request_approval</code> shows the plan and highlights the owner’s approval button without executing it.</dd>
        <dt>Customer booking</dt><dd><code>list_classes</code> filters by local day and class type. <code>start_booking</code> selects a class and prefills checkout for human payment approval.</dd>
        <dt>Studio dashboard</dt><dd>AG Studio’s read-only <code>view_schema</code>, <code>view_page</code>, <code>view_widget</code> and <code>execute_query</code> inspect the current report and data. Report editing and payment tools are not exposed.</dd>
        <dt>Disruption form</dt><dd>The declarative <code>preview_disruption</code> tool fills and submits the visible disruption form to prepare the same timeline preview.</dd>
      </dl>
      <p>Tools follow page state: preparation actions pause while the page is busy, checkout selection is unavailable during payment, and dashboard tools update as the report changes. Hover or focus the header’s <strong>Agent-ready</strong> chip to see the imperative tools currently available.</p>
      <h2>Try it in Chrome</h2>
      <ol>
        <li>Use Chrome 149 or later. WebMCP is experimental and requires an enabled origin trial or the testing flag.</li>
        <li>For local testing, open <code>chrome://flags/#enable-webmcp-testing</code>, enable WebMCP testing, and relaunch Chrome.</li>
        <li>Open Rebook in a secure context: HTTPS or a trusted localhost development address. Open a workspace, booking page, or dashboard and wait for it to finish loading.</li>
        <li>Use a WebMCP-capable assistant. The header chip appears when a model context is detected. Rebook supports the current <code>document.modelContext</code> API and feature-detects the older <code>navigator.modelContext</code> spelling.</li>
      </ol>
      <p>You can continue using every page normally when WebMCP is unavailable.</p>
    </article>
  </main>;
}
