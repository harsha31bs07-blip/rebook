import { z } from "zod";
import { clientIp } from "../api/client-ip";
import { limits } from "../api/limits";
import { isSameOrigin } from "../api/same-origin";
import { getRepository, StoreError } from "../store";

export const BookingIdSchema = z.string().transform((id) => {
  if (!/^[A-Za-z0-9_-]{32}$/.test(id)) throw new StoreError(404, "This demo has ended (demos reset when the server restarts). Start a fresh one.", "expired");
  return id;
});
export function publicCheckoutWorkspace(request: Request, bookingId: string): string {
  const id = BookingIdSchema.parse(bookingId);
  checkoutLimit(request, id);
  return getRepository().requireBookingWorkspace(id).id;
}
export const OrderIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export function checkoutLimit(request: Request, workspaceId: string): void {
  if (request.method !== "GET" && !isSameOrigin(request)) throw new StoreError(403, "Checkout must start on this site");
  limits.take([
    { key: `checkout-client:${clientIp(request)}`, max: 60, ms: 60_000 },
    { key: `checkout-workspace:${workspaceId}`, max: 120, ms: 60_000 },
    { key: "checkout-global", max: 600, ms: 60_000 },
  ]);
}
