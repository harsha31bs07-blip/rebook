import type { MoneyVerification, MoneyVerificationItem } from "./verify";

export function verificationSummary(result: MoneyVerification): string {
  if (!result.items.length) return "No PayPal refunds or payouts to verify. Simulated refunds are skipped.";
  const counts = (["refund", "payout"] as const).flatMap((kind) => {
    const rows = result.items.filter((row) => row.kind === kind);
    if (!rows.length) return [];
    const matched = rows.filter((row) => ["match", "paypal-ahead"].includes(row.match)).length;
    return [kind === "payout" && rows.length === 1 && matched === 1 ? "1 payout" : `${matched} of ${rows.length} ${kind}${rows.length === 1 ? "" : "s"}`];
  });
  return `${counts.join(" and ")} match PayPal${result.summary.unavailable ? ` · ${result.summary.unavailable} unavailable` : ""}`;
}

export function verificationNextStep(match: MoneyVerificationItem["match"]): string {
  switch (match) {
    case "paypal-ahead": return "PayPal is ahead. Refresh the console so normal reconciliation can update Rebook.";
    case "mismatch": return "The status, amount or currency differs. Compare the PayPal sandbox receipt with Rebook and check the payment status before retrying any payment.";
    case "not-found": return "PayPal could not find this record. Check the sandbox receipt and account before retrying any payment.";
    case "unavailable": return "This record could not be checked. Try Verify with PayPal again shortly.";
    default: return "Matches PayPal.";
  }
}
