"use client";

import { useEffect } from "react";
import { PublicErrorStatus } from "@/features/public-ui/status/PublicErrorStatus";

/**
 * Root error boundary for the public tree (and any admin segment without its
 * own error.tsx). Never render `error.message` — Next strips it in production
 * and in development it can carry driver detail.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return <PublicErrorStatus onRetry={reset} />;
}
