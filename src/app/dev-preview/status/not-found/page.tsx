import { PublicNotFoundStatus } from "@/features/public-ui/status/PublicNotFoundStatus";

/**
 * MOCK_ONLY static exhibit of the root `not-found.tsx` panel.
 * Does not call `notFound()` — same component and copy as the real 404.
 */
export default function NotFoundPreviewPage() {
  return <PublicNotFoundStatus />;
}
