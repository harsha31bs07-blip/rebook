import OwnerConsole from "@/components/console/owner-console";

export default async function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OwnerConsole id={id} />;
}
