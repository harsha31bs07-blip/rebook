import type { Metadata } from "next";
import CoverPage from "@/components/booking/cover-page";

export const metadata: Metadata = {
  title: "Cover request · Rebook",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function InstructorCoverPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <CoverPage token={token} />;
}
