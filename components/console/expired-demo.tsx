import OpenDemoButton from "./open-demo-button";

export default function ExpiredDemo() {
  return <main id="main-content" tabIndex={-1} className="landing"><section className="landing-copy" role="status">
    <h1>This demo has ended</h1>
    <p className="landing-description">Rebook&rsquo;s demo runs on a free server that resets when it restarts or updates, so saved demos can end early. Nothing was charged: payments run in PayPal&rsquo;s sandbox. A fresh demo takes about ten seconds.</p>
    <OpenDemoButton label="Start a fresh one" />
  </section></main>;
}
