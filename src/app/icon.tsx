import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/**
 * Favicon: the same brand placeholder mark as `BrandMark` (rounded square with
 * two inset bars), redrawn with divs because Satori has no SVG or CSS variables.
 * Geometry is copied from the 32-unit viewBox 1:1 — the bars span 11→14 and
 * 18→21, so a centred row with a 4px gap lands them where the SVG puts them.
 *
 * 🔴 P1-10 §13 forbids inventing a second brand identity. When the real logo
 * lands, `BrandMark` and this file are replaced together; keep them in sync.
 * Literal hex is unavoidable here — hence the `no-hardcoded-colors` exemption.
 */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#12151c",
        }}
      >
        <div
          style={{
            boxSizing: "border-box",
            width: 28,
            height: 28,
            borderRadius: 7,
            border: "2px solid #626c84",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
          }}
        >
          <div style={{ width: 3, height: 14, borderRadius: 1.5, background: "#e0a96d" }} />
          <div style={{ width: 3, height: 14, borderRadius: 1.5, background: "#8a93a5" }} />
        </div>
      </div>
    ),
    { ...size },
  );
}
