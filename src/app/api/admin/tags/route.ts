import { projectAdminContentPage, projectAdminSourceLabel } from "@/contracts";
import { listAdminSourceLabels } from "@/server/admin-content";

import { prisma } from "../_lib/deps";
import { sourceLabelListQuery } from "../_lib/content-route";
import { guardRead } from "../_lib/route";
import { handle } from "../_lib/respond";

export const dynamic = "force-dynamic";

/**
 * `admin.api.source_label.list` — registered in `_lib/registry.ts`, gated on
 * `content:view`.
 *
 * The handler holds no query logic: filtering, pagination bounds and the
 * `novelCount` aggregation all live in `listAdminSourceLabels`. Duplicating
 * any of it here would create a second definition of "which labels an admin
 * can see".
 */
export async function GET(request: Request) {
  return handle(async () => {
    await guardRead(request);
    const page = await listAdminSourceLabels(prisma, sourceLabelListQuery(new URL(request.url)));
    return projectAdminContentPage(page, projectAdminSourceLabel);
  });
}
