"use client";

import { useEffect } from "react";
import { PublicStatusPanel } from "@/features/public-ui/status/PublicStatusPanel";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/**
 * Root error boundary for the public tree (and any admin segment without its
 * own error.tsx). Never render `error.message` — Next strips it in production
 * and in development it can carry driver detail.
 */
export default function ErrorPage({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = getPublicT(PUBLIC_SITE_LOCALE);

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PublicStatusPanel
      bare
      testId="public-error-panel"
      title={t("errorPage.title")}
      body={t("errorPage.body")}
      homeLabel={t("unavailable.returnHome")}
    />
  );
}
