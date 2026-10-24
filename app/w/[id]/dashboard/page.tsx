import Dashboard from "@/components/insights/dashboard";
import ExpiredDemo from "@/components/console/expired-demo";
import { getRepository } from "@/lib/store";
import { connection } from "next/server";

export default async function DashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await connection();
  if (!getRepository().getWorkspace(id)) return <ExpiredDemo />;
  return <Dashboard key={id} id={id} />;
}
