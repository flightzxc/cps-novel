"use client";

import { PublicStatusPanel } from "@/features/public-ui/status/PublicStatusPanel";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import "@/styles/globals.css";

/**
 * Replaces the root layout when the layout itself fails. Must supply its own
 * html/body. Public tree stays `lang="en"`. Logging stays on `error.tsx`.
 */
export default function GlobalErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  void error;
  void reset;
  const t = getPublicT(PUBLIC_SITE_LOCALE);

  return (
    <html lang="en">
      <body className="site">
        <PublicStatusPanel
          bare
          testId="public-global-error-panel"
          title={t("errorPage.title")}
          body={t("errorPage.body")}
          homeLabel={t("unavailable.returnHome")}
        />
      </body>
    </html>
  );
}
