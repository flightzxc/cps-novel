"use client";

import { useEffect } from "react";
import { PublicStatusPanel } from "@/features/public-ui/status/PublicStatusPanel";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import "@/styles/globals.css";

/**
 * Replaces the root layout when the layout itself fails. Must supply its own
 * html/body. Public tree stays `lang="en"`.
 *
 * Logs on its own rather than deferring to `error.tsx`: a layout failure never
 * reaches that boundary, so anything logged only there would be lost.
 * Never render `error.message` — see `error.tsx`.
 */
export default function GlobalErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = getPublicT(PUBLIC_SITE_LOCALE);

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="site">
        <PublicStatusPanel
          bare
          testId="public-global-error-panel"
          title={t("errorPage.title")}
          body={t("errorPage.body")}
          homeLabel={t("unavailable.returnHome")}
          retryLabel={t("errorPage.retry")}
          onRetry={reset}
        />
      </body>
    </html>
  );
}
