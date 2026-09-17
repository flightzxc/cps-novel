import type { ReactNode } from "react";

import { ReaderSettingsProvider } from "@/features/public-ui/chapter/ReaderSettingsProvider";
import { buildReaderBootstrapScript } from "@/features/public-ui/chapter/reader-bootstrap";

/**
 * Public chapter layout. Provider sits above `[chapterNumber]` so client
 * navigations between chapters keep reader settings. Copied from the
 * dev-preview chapter layout; this route is indexable via page metadata.
 */
export default function PublicChapterLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: buildReaderBootstrapScript() }} />
      <ReaderSettingsProvider>{children}</ReaderSettingsProvider>
    </>
  );
}
