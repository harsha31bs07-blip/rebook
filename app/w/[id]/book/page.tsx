import { connection } from "next/server";
import BookingPage from "@/components/booking/booking-page";
import ExpiredDemo from "@/components/console/expired-demo";
import { getRepository } from "@/lib/store";

export default async function CustomerBookingPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  if (!getRepository().getWorkspace(id)) return <ExpiredDemo />;
  return <BookingPage id={id} clientId={process.env.PAYPAL_CLIENT_ID ?? ""} sandbox={(process.env.PAYPAL_ENV || "sandbox") === "sandbox"} />;
}
