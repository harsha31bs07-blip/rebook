import type { CheckoutReservation, WaitlistOffer } from "../store";

export const checkoutHoldsSeat = (row: CheckoutReservation) => row.status === "capturing" || (row.status === "pending" && row.expiresAt > Date.now());
export function offerHoldsSeat(offer: WaitlistOffer, reservations: CheckoutReservation[]): boolean {
  return offer.status === "offered" && (Date.parse(offer.expiresAt) > Date.now() || reservations.some((row) => row.waitlistOfferId === offer.id && checkoutHoldsSeat(row)));
}
export function heldOffers(sessionId: string, offers: WaitlistOffer[], reservations: CheckoutReservation[], excluding?: string): number {
  return offers.filter((offer) => offer.sessionId === sessionId && offer.id !== excluding && offerHoldsSeat(offer, reservations)
    && !reservations.some((row) => row.waitlistOfferId === offer.id && checkoutHoldsSeat(row))).length;
}
