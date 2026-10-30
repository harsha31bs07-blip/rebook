import OpenDemoButton from "@/components/console/open-demo-button";
import Link from "next/link";

const repo = "https://github.com/harsha31bs07-blip/rebook/blob/main";
// Every number links to the published evidence behind it.
const PROOF = [
  { value: "43/45", label: "messy owner messages read correctly", detail: "Rules alone: 22. Zero dangerous guesses.", href: `${repo}/docs/interpretation-messy-eval.md`, link: "Live evaluation" },
  { value: "22/24", label: "customer requests handled correctly", detail: "One real option to confirm, or a clarifying question. Zero unsafe actions, including injection attempts.", href: `${repo}/docs/customer-assistant-eval.md`, link: "Live evaluation" },
  { value: "~7 s", label: "for six PayPal sandbox refunds after one approval, in our sandbox runs", detail: "A retry reuses the same request ID, and each refund is reconciled with PayPal.", href: "/built-with#paypal", link: "How refunds work" },
  { value: "1,300+", label: "automated tests", detail: "Plus a scripted browser run of the whole judge path against the live site.", href: `${repo}#tests`, link: "Test notes" },
];

export default function Home() {
  return <main id="main-content" tabIndex={-1} className="landing">
    <header className="landing-header"><Link href="/" className="wordmark"><span className="brand-symbol" aria-hidden="true">r</span>rebook<span className="wordmark-dot">.</span><span className="sr-only"> home</span></Link><span className="pill">Built for studio owners</span></header>
    <section className="landing-hero">
      <div className="landing-copy"><p className="eyebrow">Keep your people. Keep your week.</p><h1>When your schedule breaks, rebook everyone in one approval.</h1><p className="landing-description">Life happens. Keep your studio moving with a recovery plan that puts your customers first.</p><OpenDemoButton /><p className="import-link"><Link href="/import">Or try it on your own studio’s week</Link> · import a booking export</p><p className="sandbox-note">Each visit gets its own studio. The disruption scenarios use PayPal sandbox payments; the rest of the week is simulated and labelled.</p><div className="value-lines"><div><span>01</span><p>Describe the disruption in your own words, or paste the message you got.</p></div><div><span>02</span><p>See a better week before you approve it.</p></div><div><span>03</span><p>Customers choose. Refunds and cover pay go out with PayPal.</p></div></div></div>
      <div className="landing-preview" aria-label="Illustration of a schedule recovery">
        <div className="preview-top"><div><p className="eyebrow">A fresh start for your week</p><strong>Studio recovery</strong></div><span className="pill success-pill">Ready to review</span></div>
        <div className="mini-timeline"><div className="mini-days"><span>TEAM</span><span>MON</span><span>TUE</span><span>WED</span></div><div className="mini-row"><strong>Maya</strong><div className="mini-event mini-ghost">Dance Flow<span>Original class</span></div><div className="mini-event class-dance">Dance Flow<span>New time found</span></div><div /></div><div className="mini-row"><strong>Alex</strong><div className="mini-event class-yoga">Yoga Flow<span>Cover arranged</span></div><div /><div className="mini-event class-pilates">Pilates Flow<span>All set</span></div></div><div className="mini-row"><strong>Sam</strong><div className="mini-event class-spin">Spin Ride<span>All set</span></div><div /><div className="mini-event class-hiit">HIIT Flow<span>All set</span></div></div></div>
        <div className="preview-recovery"><span className="recovery-mark" aria-hidden="true">✓</span><div><h2>There’s a way forward.</h2><p>Substitutes found. New times arranged.<br />Every affected customer taken care of.</p></div></div>
        <div className="preview-bottom"><span>You review every change.</span><strong>You make the call.</strong></div>
      </div>
    </section>
    <section className="proof-strip" aria-labelledby="proof-title"><h2 id="proof-title" className="eyebrow">Measured, not promised</h2>
      <ul className="proof-grid">{PROOF.map((item) => <li key={item.value}><strong>{item.value}</strong><p>{item.label}</p><span>{item.detail}</span>
        {item.href.startsWith("/") ? <Link href={item.href}>{item.link}</Link> : <a href={item.href} target="_blank" rel="noreferrer">{item.link}<span className="sr-only"> (opens GitHub)</span></a>}</li>)}</ul>
    </section>
    <footer className="landing-footer"><span>Less admin. More room to move.</span><Link href="/built-with">How it&apos;s built</Link><Link href="/agent-ready">Agent-ready: MCP and WebMCP</Link><span>Rebook · A calmer week starts here.</span></footer>
  </main>;
}
