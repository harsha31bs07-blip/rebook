import { connection } from "next/server";
import Link from "next/link";
import BookingPage from "@/components/booking/booking-page";
import ExpiredDemo from "@/components/console/expired-demo";
import { getRepository } from "@/lib/store";

export default async function CustomerBookingPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const workspace = getRepository().getWorkspace(id);
  if (!workspace) return <ExpiredDemo />;
  const publicPath = `/b/${workspace.bookingId}`;
  return <><p className="muted">Owner preview · Share the public booking page: <Link href={publicPath}>{publicPath}</Link></p>
    <BookingPage id={workspace.bookingId} clientId={process.env.PAYPAL_CLIENT_ID ?? ""} sandbox /></>;
}
