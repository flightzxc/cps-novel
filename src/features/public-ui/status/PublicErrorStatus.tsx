"use client";

import { PublicStatusPanel } from "./PublicStatusPanel";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/**
 * Shared copy + layout for the root error boundary and the static
 * `/dev-preview/status/error` exhibit. Logging stays in `error.tsx` /
 * `global-error.tsx` — a preview page must not `console.error` a fake error.
 *
 * When `onRetry` is omitted the retry button still renders (same visual as
 * the real boundary) and no-ops, so the preview can be a Server Component.
 */
export function PublicErrorStatus({
  onRetry,
  testId = "public-error-panel",
  digest,
}: {
  onRetry?: () => void;
  testId?: string;
  digest?: string;
}) {
  const t = getPublicT(PUBLIC_SITE_LOCALE);
  return (
    <PublicStatusPanel
      bare
      testId={testId}
      title={t("errorPage.title")}
      body={t("errorPage.body")}
      homeLabel={t("unavailable.returnHome")}
      retryLabel={t("errorPage.retry")}
      onRetry={onRetry ?? (() => undefined)}
      digestLabel={digest ? t("errorPage.digest", { digest }) : undefined}
    />
  );
}
