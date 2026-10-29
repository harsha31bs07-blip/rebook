"use client";

import { useState } from "react";
import { api } from "../../lib/client/api";
import type { MoneyVerification } from "../../lib/paypal/verify";
import { verificationNextStep, verificationSummary } from "../../lib/paypal/verification-result";
import { formatMoney } from "../../lib/domain/time";

export function VerificationResult({ result, timezone }: { result: MoneyVerification; timezone: string }) {
  const checked = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(result.checkedAt));
  return <div className="paypal-verification">
    <p role="status">{verificationSummary(result)} · checked <time dateTime={result.checkedAt}>{checked}</time></p>
    {result.items.length > 0 && <details><summary>View PayPal verification details</summary><ul>{result.items.map((item, index) => <li key={index}
      className={item.match === "mismatch" || item.match === "not-found" ? "warning" : undefined}>
      <strong>{item.label}</strong><br />
      {formatMoney(item.amount, item.currency)} · Rebook: {item.rebook} · PayPal: {item.paypal}<br />
      <small>Source: {item.source}</small><p>{verificationNextStep(item.match)}</p>
    </li>)}</ul></details>}
  </div>;
}

export default function PayPalVerification({ workspaceId, timezone }: { workspaceId: string; timezone: string }) {
  const [result, setResult] = useState<MoneyVerification>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function verify() {
    setBusy(true); setError("");
    try { setResult(await api.verifyMoney(workspaceId)); }
    catch { setError("PayPal verification could not be completed. Please try again shortly."); }
    finally { setBusy(false); }
  }
  return <div className="paypal-verification">
    <button type="button" disabled={busy} onClick={() => void verify()}>{busy ? "Checking PayPal…" : "Verify with PayPal"}</button>
    <p role="status">{busy ? "Checking sandbox refunds and cover payouts with PayPal…" : error}</p>
    {result && <VerificationResult result={result} timezone={timezone} />}
  </div>;
}
