import type { Metadata } from "next";
import { Figtree, Fraunces } from "next/font/google";
import { connection } from "next/server";
import "./globals.css";

// Studio Linen type: Figtree for the interface (open, even spacing at small sizes), Fraunces for a handful of headlines.
const uiFont = Figtree({ subsets: ["latin"], variable: "--font-ui", display: "swap" });
const displayFont = Fraunces({ subsets: ["latin"], variable: "--font-serif", display: "swap" });

export const metadata: Metadata = {
  // Link previews need absolute URLs; behind Render the request host is internal.
  metadataBase: new URL(process.env.PUBLIC_ORIGIN?.trim() || "https://rebook-by9u.onrender.com"),
  title: "Rebook — a calmer week for your studio",
  description: "When your schedule breaks, rebook everyone in one approval. Preview a recovery plan and handle refunds with PayPal sandbox.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Nonces are generated per request; the bootstrap must never be prerendered.
  await connection();
  return (
    <html
      lang="en"
      className={`${uiFont.variable} ${displayFont.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col"><a className="skip-link" href="#main-content">Skip to main content</a>{children}</body>
    </html>
  );
}
