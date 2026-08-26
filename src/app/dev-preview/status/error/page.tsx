import { PublicErrorStatus } from "@/features/public-ui/status/PublicErrorStatus";

/**
 * MOCK_ONLY static exhibit of the root `error.tsx` panel.
 * Does not throw — same component and copy as the real boundary, retry no-ops.
 */
export default function ErrorPreviewPage() {
  return <PublicErrorStatus />;
}
