import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    const paypal = "https://www.paypal.com https://www.sandbox.paypal.com https://www.paypalobjects.com";
    const csp = [
      "default-src 'self'",
      // Next's bootstrap and bundled chart/scheduler styles require inline content.
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""} ${paypal}`,
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self' ${paypal}`,
      `frame-src ${paypal}`,
      `img-src 'self' data: blob: ${paypal}`,
      "font-src 'self' data:", "worker-src 'self' blob:",
      "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
    ].join("; ");
    return [{ source: "/:path*", headers: [
      { key: "Content-Security-Policy", value: csp },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ] }];
  },
};

export default nextConfig;
