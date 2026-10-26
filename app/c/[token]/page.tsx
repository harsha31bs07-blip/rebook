import type { Metadata } from "next";
import CustomerChoicePage from "@/components/booking/customer-choice-page";

export const metadata: Metadata = {
  title: "Your class, your choice · Rebook",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ChoicePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <CustomerChoicePage token={token} />;
}
