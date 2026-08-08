import { projectAdminChapterListItem, projectAdminContentPage } from "@/contracts";
import { listAdminNovelChapters } from "@/server/admin-content";

import { chapterListQuery, guardContentRead } from "../../_lib/content-route";
import { prisma } from "../../_lib/deps";
import { handle } from "../../_lib/respond";

export const dynamic = "force-dynamic";

/**
 * `admin.api.novel_chapter.list` — `content:view`.
 *
 * Returns `hasContent` and `charCount`, never `body`. The chapter body has its
 * own route, its own capability and its own audit row precisely so that paging
 * through a table of contents is not also a bulk read of licensed prose.
 */
export async function GET(request: Request) {
  return handle(async () => {
    await guardContentRead(request);
    const page = await listAdminNovelChapters(prisma, chapterListQuery(new URL(request.url)));
    return projectAdminContentPage(page, projectAdminChapterListItem);
  });
}
