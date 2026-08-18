import type { Metadata } from "next";

import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Shared 404 shell for this novel segment (missing slug, short-id mismatch,
 * takedown/withdrawn). V1 maps rights-removal to `notFound()` so Next emits
 * a real HTTP 404; HTTP 410 is post-V1 (proxy layer).
 */
export default function NovelNotFoundPage() {
  return <UnavailableScreen reason="unpublished" homeHref="/" />;
}
