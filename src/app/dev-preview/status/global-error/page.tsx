import { PublicErrorStatus } from "@/features/public-ui/status/PublicErrorStatus";

/**
 * MOCK_ONLY static exhibit of the root `global-error.tsx` panel.
 * Does not wrap a second `html`/`body` (this page already sits inside the
 * site layout). The real global-error boundary still supplies its own
 * document shell when the root layout fails.
 */
export default function GlobalErrorPreviewPage() {
  return <PublicErrorStatus testId="public-global-error-panel" />;
}
