import Dashboard from "@/components/insights/dashboard";

export default async function DashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Dashboard key={id} id={id} />;
}
