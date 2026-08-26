import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/**
 * Code-generated favicon. Colors match `.site` tokens (`--novel-bg` /
 * `--novel-accent`). A letter mark, not a brand asset — do not copy
 * PulseDrama images.
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
          color: "#f0e4ce",
          fontSize: 20,
          fontWeight: 700,
          fontFamily: "Georgia, ui-serif, serif",
          letterSpacing: "-0.04em",
        }}
      >
        N
      </div>
    ),
    { ...size },
  );
}
