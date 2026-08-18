"use client";

import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";
import { GONE_DIGEST } from "@/app/_lib/http";

/**
 * If `gone()` is thrown and Next maps it to an error boundary instead of a
 * native 410 page, still show the takedown screen on this URL.
 */
export default function NovelSegmentError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  if (error.digest === GONE_DIGEST || error.message === GONE_DIGEST) {
    return <UnavailableScreen reason="takedown" homeHref="/" />;
  }
  throw error;
}
