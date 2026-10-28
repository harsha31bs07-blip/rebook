import OpenDemoButton from "@/components/console/open-demo-button";
import Link from "next/link";

export default function Home() {
  return <main id="main-content" tabIndex={-1} className="landing">
    <header className="landing-header"><Link href="/" className="wordmark"><span className="brand-symbol" aria-hidden="true">r</span>rebook<span className="wordmark-dot">.</span><span className="sr-only"> home</span></Link><span className="pill">Built for studio owners</span></header>
    <section className="landing-hero">
      <div className="landing-copy"><p className="eyebrow">Keep your people. Keep your week.</p><h1>When your schedule breaks, rebook everyone in one approval.</h1><p className="landing-description">Life happens. Keep your studio moving with a recovery plan that puts your customers first.</p><OpenDemoButton /><p className="sandbox-note">Each visit gets its own studio. The disruption scenarios use PayPal sandbox payments; the rest of the week is simulated and labelled.</p><div className="value-lines"><div><span>01</span><p>Describe the disruption in your own words, or paste the message you got.</p></div><div><span>02</span><p>See a better week before you approve it.</p></div><div><span>03</span><p>Customers choose. Refunds and cover pay go out with PayPal.</p></div></div></div>
      <div className="landing-preview" aria-label="Illustration of a schedule recovery">
        <div className="preview-top"><div><p className="eyebrow">A fresh start for your week</p><strong>Studio recovery</strong></div><span className="pill success-pill">Ready to review</span></div>
        <div className="mini-timeline"><div className="mini-days"><span>TEAM</span><span>MON</span><span>TUE</span><span>WED</span></div><div className="mini-row"><strong>Maya</strong><div className="mini-event mini-ghost">Dance Flow<span>Original class</span></div><div className="mini-event class-dance">Dance Flow<span>New time found</span></div><div /></div><div className="mini-row"><strong>Alex</strong><div className="mini-event class-yoga">Yoga Flow<span>Cover arranged</span></div><div /><div className="mini-event class-pilates">Pilates Flow<span>All set</span></div></div><div className="mini-row"><strong>Sam</strong><div className="mini-event class-spin">Spin Ride<span>All set</span></div><div /><div className="mini-event class-hiit">HIIT Flow<span>All set</span></div></div></div>
        <div className="preview-recovery"><span className="recovery-mark" aria-hidden="true">✓</span><div><h2>There’s a way forward.</h2><p>Substitutes found. New times arranged.<br />Every affected customer taken care of.</p></div></div>
        <div className="preview-bottom"><span>You review every change.</span><strong>You make the call.</strong></div>
      </div>
    </section>
    <footer className="landing-footer"><span>Less admin. More room to move.</span><Link href="/built-with">How it&apos;s built</Link><Link href="/agent-ready">Agent-ready with WebMCP</Link><span>Rebook · A calmer week starts here.</span></footer>
  </main>;
}
