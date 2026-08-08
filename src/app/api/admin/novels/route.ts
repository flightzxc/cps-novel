import { projectAdminContentPage, projectAdminNovelListItem } from "@/contracts";
import { listAdminNovels } from "@/server/admin-content";

import { prisma } from "../_lib/deps";
import { guardContentRead, novelListQuery } from "../_lib/content-route";
import { handle } from "../_lib/respond";

export const dynamic = "force-dynamic";

/**
 * `admin.api.novel.list` — registered in `_lib/registry.ts`, gated on
 * `content:view`.
 *
 * The handler holds no query logic: filtering, pagination bounds and the
 * aggregate joins all live in `listAdminNovels`. Duplicating any of it here
 * would create a second definition of "which novels an admin can see".
 */
export async function GET(request: Request) {
  return handle(async () => {
    await guardContentRead(request);
    const page = await listAdminNovels(prisma, novelListQuery(new URL(request.url)));
    return projectAdminContentPage(page, projectAdminNovelListItem);
  });
}
