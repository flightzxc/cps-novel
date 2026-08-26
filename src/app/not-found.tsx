import type { Metadata } from "next";
import { PublicNotFoundStatus } from "@/features/public-ui/status/PublicNotFoundStatus";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Root 404. No chrome data is available here, so this is the headless shell
 * of UnavailableScreen — same type, no header or footer.
 */
export default function NotFoundPage() {
  return <PublicNotFoundStatus />;
}
