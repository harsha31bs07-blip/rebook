import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Your class, your choice · Rebook",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ChoicePage({ params }: { params: Promise<{ id: string; token: string }> }) {
  const { token } = await params;
  redirect(`/c/${encodeURIComponent(token)}`);
}
