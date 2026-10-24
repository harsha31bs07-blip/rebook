import OpenDemoButton from "./open-demo-button";

export default function ExpiredDemo() {
  return <main id="main-content" tabIndex={-1} className="landing"><section className="landing-copy" role="status">
    <h1>This demo has ended</h1>
    <p className="landing-description">Demos reset when the server restarts. Start a fresh one.</p>
    <OpenDemoButton label="Start a fresh one" />
  </section></main>;
}
