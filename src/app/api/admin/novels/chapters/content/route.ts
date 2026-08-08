import { projectAdminChapterContent } from "@/contracts";
import { readAdminChapterContent } from "@/server/admin-content";

import { contentReadRequestId } from "../../../_lib/content-route";
import { guardRead } from "../../../_lib/route";
import { prisma } from "../../../_lib/deps";
import { AdminContentNotFoundError, handle } from "../../../_lib/respond";

export const dynamic = "force-dynamic";

/**
 * `admin.api.novel_chapter.content` — the only route that returns chapter prose,
 * and the only one gated on `content:read`.
 *
 * `readAdminChapterContent` writes a metadata-only `operation_audit` row inside
 * the same transaction as the read, so "who opened which chapter, when" is a
 * property of calling this route rather than something the UI has to remember to
 * report. The actor id comes from the guarded session — never from the request.
 *
 * No 2FA step-up: `content:read` is registered in `ADMIN_CAPABILITY_CONFIG` with
 * `requiresTwoFactor: false`, so `enforceCapability` checks the grant and stops
 * there. Authorisation is entirely `guardRead`'s, exactly as for every other
 * admin route.
 */
export async function GET(request: Request) {
  return handle(async () => {
    const context = await guardRead(request);
    const params = new URL(request.url).searchParams;
    const content = await readAdminChapterContent(prisma, {
      novelId: params.get("novelId")?.trim() ?? "",
      chapterId: params.get("chapterId")?.trim() ?? "",
      context: {
        actorId: context.identity.id,
        requestId: contentReadRequestId(request),
      },
    });
    if (!content) throw new AdminContentNotFoundError("chapter");
    return projectAdminChapterContent(content);
  });
}
