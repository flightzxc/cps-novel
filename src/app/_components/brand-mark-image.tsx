/**
 * `BrandMark`'s geometry as an `ImageResponse` tree, for the icon routes.
 *
 * Satori parses neither SVG nor CSS variables, so the mark has to be redrawn
 * with divs and literal hex. It lives here rather than in each icon route so
 * there is exactly one copy: `icon.tsx` and `apple-icon.tsx` differ only in
 * output size.
 *
 * Every measurement is the 32-unit `BrandMark` viewBox scaled by `size / 32`,
 * so any output size keeps the same proportions.
 *
 * 🔴 P1-10 §13 forbids inventing a second brand identity. When the real logo
 * lands, `src/components/BrandMark.tsx` and this file are replaced together.
 */
const GRID = 32;

/** `--novel-bg`, `--novel-border-strong`, `--novel-primary`, `--novel-fg-subtle`. */
const CANVAS = "#12151c";
const FRAME = "#626c84";
const BAR_WARM = "#e0a96d";
const BAR_COOL = "#8a93a5";

export function brandMarkImage(size: number) {
  const u = size / GRID;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: CANVAS,
      }}
    >
      <div
        style={{
          boxSizing: "border-box",
          width: 28 * u,
          height: 28 * u,
          borderRadius: 7 * u,
          border: `${2 * u}px solid ${FRAME}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 4 * u,
        }}
      >
        <div
          style={{ width: 3 * u, height: 14 * u, borderRadius: 1.5 * u, background: BAR_WARM }}
        />
        <div
          style={{ width: 3 * u, height: 14 * u, borderRadius: 1.5 * u, background: BAR_COOL }}
        />
      </div>
    </div>
  );
}
