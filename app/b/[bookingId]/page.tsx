import { connection } from "next/server";
import BookingPage from "@/components/booking/booking-page";
import ExpiredDemo from "@/components/console/expired-demo";
import { getRepository } from "@/lib/store";

export default async function PublicBookingPage({ params }: { params: Promise<{ bookingId: string }> }) {
  await connection();
  const { bookingId } = await params;
  if (!getRepository().getWorkspaceByBookingId(bookingId)) return <ExpiredDemo />;
  return <BookingPage id={bookingId} clientId={process.env.PAYPAL_CLIENT_ID ?? ""} sandbox />;
}
