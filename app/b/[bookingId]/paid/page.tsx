import { connection } from "next/server";
import PayPalReturn from "@/components/booking/paypal-return";
import ExpiredDemo from "@/components/console/expired-demo";
import { getRepository } from "@/lib/store";

export default async function PayPalReturnPage({ params, searchParams }: { params: Promise<{ bookingId: string }>; searchParams: Promise<{ token?: string | string[] }> }) {
  await connection();
  const [{ bookingId }, { token }] = await Promise.all([params, searchParams]);
  const workspace = getRepository().getWorkspaceByBookingId(bookingId);
  if (!workspace) return <ExpiredDemo />;
  const orderId = typeof token === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(token) ? token : undefined;
  return <PayPalReturn bookingId={bookingId} orderId={orderId} timezone={workspace.state.studio.timezone} />;
}
