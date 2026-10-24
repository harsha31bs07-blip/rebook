import type { Metadata } from "next";
import localFont from "next/font/local";
import { connection } from "next/server";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/geist-latin.woff2",
  variable: "--font-geist-sans",
  display: "swap",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Rebook — a calmer week for your studio",
  description: "When your schedule breaks, rebook everyone in one click. Preview a recovery plan and handle refunds with PayPal sandbox.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Nonces are generated per request; the bootstrap must never be prerendered.
  await connection();
  return (
    <html
      lang="en"
      className={`${geistSans.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col"><a className="skip-link" href="#main-content">Skip to main content</a>{children}</body>
    </html>
  );
}
