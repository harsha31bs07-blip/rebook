import Link from "next/link";

export default async function DashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main className="placeholder-page"><p className="wordmark">rebook.</p><p className="eyebrow">Studio dashboard</p><h1>Coming soon</h1><p className="muted">A clearer picture of your studio, all in one place.</p><Link className="primary button-link" href={`/w/${id}`}>Back to your schedule</Link></main>;
}
