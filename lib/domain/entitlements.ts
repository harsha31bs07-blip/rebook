import type { Booking } from "./types";

export function entitlementLabel(entitlement: NonNullable<Booking["entitlement"]>): `Returns 1 visit · ${string}` | "Membership · no charge" {
  return entitlement.kind === "pack" ? `Returns 1 visit · ${entitlement.name}` : "Membership · no charge";
}

export function entitlementPaymentLabel(entitlement: NonNullable<Booking["entitlement"]>): string {
  return entitlement.kind === "pack" ? `Class pack · ${entitlement.name}` : "Membership · no charge";
}

export function entitlementReceipt(entitlement: NonNullable<Booking["entitlement"]>): string {
  return entitlement.kind === "pack" ? `Visit returned to your ${entitlement.name}` : `Booking cancelled — covered by your ${entitlement.name}`;
}

export function entitlementMessage(entitlement: NonNullable<Booking["entitlement"]>): string {
  return entitlement.kind === "pack" ? `We'll return the visit to your ${entitlement.name}.`
    : `This class is part of your ${entitlement.name}, so there's nothing to refund.`;
}
