import { ImageResponse } from "next/og";

import { brandMarkImage } from "./_components/brand-mark-image";

/**
 * iOS home-screen / bookmark icon. 180px is the size iOS asks for and
 * downscales from; one entry is enough, so there is no second size here.
 *
 * The canvas is filled edge to edge on purpose — iOS applies its own corner
 * mask, and a transparent or inset-cornered source would show as a dark square
 * behind it. The mark's own rounded frame sits well inside that mask.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(brandMarkImage(size.width), { ...size });
}
