import OwnerConsole from "@/components/console/owner-console";
import ExpiredDemo from "@/components/console/expired-demo";
import { getRepository } from "@/lib/store";
import { connection } from "next/server";

export default async function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await connection();
  if (!getRepository().getWorkspace(id)) return <ExpiredDemo />;
  return <OwnerConsole id={id} />;
}
