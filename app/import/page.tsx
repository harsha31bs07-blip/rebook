import Link from "next/link";
import ImportPage from "@/components/import/import-page";

export const metadata = { title: "Bring your week · Rebook", description: "Try Rebook on your own studio's week: import a booking export, check what Rebook read, and plan a recovery." };

export default function Import() {
  return <main id="main-content" tabIndex={-1} className="landing import-landing">
    <header className="landing-header"><Link href="/" className="wordmark"><span className="brand-symbol" aria-hidden="true">r</span>rebook<span className="wordmark-dot">.</span><span className="sr-only"> home</span></Link><span className="pill">Try it on your own week</span></header>
    <ImportPage />
  </main>;
}
