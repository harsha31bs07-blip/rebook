import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import WaitlistPanel from "../components/console/waitlist-panel";
import WaitlistOfferPage, { OfferDetails } from "../components/booking/waitlist-offer-page";
import type { WaitlistOfferView } from "../lib/waitlist/service";

vi.mock("../components/booking/booking-page", () => ({ Payments: () => <div>PayPal checkout</div> }));

const data: WaitlistOfferView = { status: "offered", expiresAt: "2026-11-08T18:00:00Z", studio: { name: "Northstar", timezone: "America/New_York" },
  customer: { name: "Avery", email: "avery@example.com" }, bookingId: "public-id", canClaim: true, checkoutPending: false, entitlement: undefined,
  session: { id: "class", classType: "yoga", title: "Yoga Flow", start: "2026-11-09T12:00:00Z", end: "2026-11-09T13:00:00Z", price: "22.00", capacity: 1, bookingPaused: false, seatsLeft: 0, instructor: "Alex", room: "Mat studio" } };
it("renders the held offer in studio time with instructor and room", () => {
  const html = renderToStaticMarkup(<OfferDetails data={data} />);
  for (const copy of ["Northstar", "Yoga Flow", "Alex", "Mat studio", "held a spot", "1:00 PM", 'role="status"']) expect(html).toContain(copy);
  expect(renderToStaticMarkup(<WaitlistOfferPage token={"a".repeat(43)} clientId="sandbox" />)).toContain("Loading your waitlist spot");
});
it.each(["claimed", "declined", "expired", "withdrawn"] as const)("renders a plain %s outcome", (status) => {
  const html = renderToStaticMarkup(<OfferDetails data={{ ...data, status }} />);
  expect(html).toContain(status === "claimed" ? "You&#x27;re booked." : status === "withdrawn" ? "This class changed" : status === "declined" ? "Thanks for letting us know" : "This offer has expired");
  expect(html).not.toContain("<button");
});
it("renders waiting counts, held offers and final outcomes in the console panel", () => {
  const html = renderToStaticMarkup(<WaitlistPanel timezone="America/New_York" onMessages={vi.fn()} classes={[{ sessionId: "class", title: "Yoga Flow", start: "2026-11-09T12:00:00.000Z", waiting: 2,
    offers: ["offered", "claimed", "declined", "expired", "withdrawn"].map((status, index) => ({ id: String(index), status: status as "offered", expiresAt: data.expiresAt, customerName: "Avery" })) }]} />);
  for (const copy of ["Waitlist", "2 waiting", "Yoga Flow · Nov 9, 7:00 AM", "1 open offer<", "held until", "claimed", "declined", "expired", "Message waitlist customers", 'id="waitlist"']) expect(html).toContain(copy);
});
