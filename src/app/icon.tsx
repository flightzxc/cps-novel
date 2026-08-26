import { ImageResponse } from "next/og";

import { brandMarkImage } from "./_components/brand-mark-image";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/** Browser tab / bookmark favicon. Geometry lives in `brandMarkImage`. */
export default function Icon() {
  return new ImageResponse(brandMarkImage(size.width), { ...size });
}
