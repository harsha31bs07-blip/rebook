import { ImageResponse } from "next/og";

export const alt = "Rebook: when your schedule breaks, rebook everyone in one approval";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Link-preview card in Studio Linen colours; the figures are the live demo's own recovery. */
export default function OpenGraphImage() {
  const stat = (value: string, label: string) => <div style={{ display: "flex", flexDirection: "column", padding: "18px 26px", border: "2px solid #e8e1d5", borderRadius: 18, background: "#fffdf9" }}>
    <span style={{ fontSize: 44, color: "#2b2622", fontWeight: 700 }}>{value}</span><span style={{ fontSize: 22, color: "#6b625a" }}>{label}</span></div>;
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "64px 72px", background: "#f6f2eb", color: "#2b2622" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div style={{ width: 64, height: 64, borderRadius: 16, background: "#3f6b4f", color: "#fffdf9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 44, fontWeight: 700 }}>r</div>
        <span style={{ fontSize: 46, fontWeight: 700, letterSpacing: -2 }}>rebook</span><span style={{ fontSize: 46, fontWeight: 700, color: "#b5643c", marginLeft: -18 }}>.</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <span style={{ fontSize: 68, lineHeight: 1.05, letterSpacing: -2, maxWidth: 980 }}>When your schedule breaks, rebook everyone in one approval.</span>
        <span style={{ fontSize: 28, color: "#4a433c" }}>A recovery desk for class studios · refunds and cover pay with PayPal</span>
      </div>
      <div style={{ display: "flex", gap: 18 }}>{stat("25 of 31", "bookings kept")}{stat("$577", "of $712 kept")}{stat("6", "PayPal refunds, one approval")}</div>
    </div>,
    size,
  );
}
