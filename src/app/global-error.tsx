"use client";

import { useEffect } from "react";
import { PublicErrorStatus } from "@/features/public-ui/status/PublicErrorStatus";
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
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="site">
        <PublicErrorStatus testId="public-global-error-panel" onRetry={reset} digest={error.digest} />
      </body>
    </html>
  );
}
