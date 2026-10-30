import type { Metadata } from "next";
import WaitlistOfferPage from "@/components/booking/waitlist-offer-page";

export const metadata: Metadata = { title: "Your waitlist spot ? Rebook", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function OfferPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <WaitlistOfferPage token={token} clientId={process.env.PAYPAL_CLIENT_ID ?? ""} />;
}
