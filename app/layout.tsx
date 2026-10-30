import type { Metadata } from "next";
import { Instrument_Sans, Instrument_Serif } from "next/font/google";
import { connection } from "next/server";
import "./globals.css";

// Studio Linen type: Instrument Sans for the interface, Instrument Serif for a handful of display moments.
const uiFont = Instrument_Sans({ subsets: ["latin"], variable: "--font-ui", display: "swap" });
const displayFont = Instrument_Serif({ subsets: ["latin"], weight: "400", variable: "--font-serif", display: "swap" });

export const metadata: Metadata = {
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
