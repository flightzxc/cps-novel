import { projectAdminNovelDetail } from "@/contracts";
import { getAdminNovelDetail } from "@/server/admin-content";

import { guardRead } from "../../_lib/route";
import { prisma } from "../../_lib/deps";
import { AdminContentNotFoundError, handle } from "../../_lib/respond";

export const dynamic = "force-dynamic";

/** `admin.api.novel.detail` — `content:view`. Identity travels as `?novelId=`. */
export async function GET(request: Request) {
  return handle(async () => {
    await guardRead(request);
    const novelId = new URL(request.url).searchParams.get("novelId")?.trim() ?? "";
    const detail = await getAdminNovelDetail(prisma, novelId);
    if (!detail) throw new AdminContentNotFoundError("novel");
    return projectAdminNovelDetail(detail);
  });
}
