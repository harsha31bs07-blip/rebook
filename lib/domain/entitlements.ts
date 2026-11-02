import type { Booking } from "./types";
import { localParts } from "./time";
import type { PackBalanceChange } from "./pack-balances";

export function entitlementLabel(entitlement: NonNullable<Booking["entitlement"]>, balance?: PackBalanceChange): `Returns 1 visit · ${string}` | "Membership · no charge" {
  return entitlement.kind === "pack" ? `Returns 1 visit · ${entitlement.name}${balance ? ` · ${balance.before} → ${balance.after} left` : ""}` : "Membership · no charge";
}

export function entitlementPaymentLabel(entitlement: NonNullable<Booking["entitlement"]>, balance?: number | null): string {
  return entitlement.kind === "pack" ? `Class pack · ${entitlement.name}${balance != null ? ` · ${balance} visits left` : ""}` : "Membership · no charge";
}

export function packExpiryNote(entitlement: NonNullable<Booking["entitlement"]>, classStart?: string, timezone = "UTC"): string {
  if (entitlement.kind !== "pack" || !entitlement.expires || !classStart) return "";
  const days = (Date.parse(entitlement.expires) - Date.parse(localParts(classStart, timezone).dateKey)) / 86_400_000;
  return days >= 0 && days <= 14 ? ` It expires on ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${entitlement.expires}T00:00:00Z`))}.` : "";
}

export function entitlementReceipt(entitlement: NonNullable<Booking["entitlement"]>, balance?: number | null, classStart?: string, timezone?: string): string {
  const expiry = packExpiryNote(entitlement, classStart, timezone);
  return entitlement.kind === "pack" ? `Visit returned to your ${entitlement.name}${balance != null ? ` · ${balance} visits left${expiry ? `.${expiry}` : ""}` : ""}` : `Booking cancelled — covered by your ${entitlement.name}`;
}

export function entitlementMessage(entitlement: NonNullable<Booking["entitlement"]>, balanceBefore?: number | null, classStart?: string, timezone?: string): string {
  return entitlement.kind === "pack" ? `We'll return the visit to your ${entitlement.name}${balanceBefore != null ? ` (you'll have ${balanceBefore + 1} visits left).${packExpiryNote(entitlement, classStart, timezone)}` : "."}`
    : `This class is part of your ${entitlement.name}, so there's nothing to refund.`;
}
