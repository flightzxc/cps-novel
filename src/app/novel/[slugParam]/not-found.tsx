import { NovelNotFoundBody, notFoundMetadata } from "@/app/_pages/novel-not-found";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const metadata = notFoundMetadata;

/**
 * Shared 404 shell for this novel segment (missing slug, short-id mismatch,
 * takedown/withdrawn). V1 maps rights-removal to `notFound()` so Next emits
 * a real HTTP 404; HTTP 410 is post-V1 (proxy layer).
 */
export default function NovelNotFoundPage() {
  return NovelNotFoundBody({ locale: PUBLIC_SITE_LOCALE });
}
