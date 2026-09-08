import Link from "next/link";
import { notFound } from "next/navigation";

import { isArticleBlogEnabled } from "@/lib/flags";

import { AdminShell } from "../../_components/admin-shell";
import { sessionView } from "../../_lib/page-guard";
import { ContentCapabilityDenied } from "../../novels/_components/content-states";
import { requireContentPage } from "../../novels/_lib/content-page-guard";
import { BlogCreateForm } from "./_components/blog-create-form";

/**
 * C-28 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-28):
 * "新建博客" entry page, CPS wording/structure ADAPTed
 * (`cps-admin-v851-admin-host`'s `src/app/(admin)/articles/new-blog/page.tsx`
 * + `article-blog-create-form.tsx`) — same "抬头返回链接 + 标题 + 说明 + 表单"
 * shell, same field set minus the three CPS has that this repo has no home
 * for (博客分类下拉、标签多选、状态与发布时间 — see this file's own delivery
 * notes for why each is a genuine EXCLUDE, not an oversight).
 *
 * `force-dynamic` + a `notFound()` kill switch on `FEATURE_ARTICLE_BLOG` —
 * same shape `src/app/dev-preview/layout.tsx` already uses for its own
 * kill switch: without `force-dynamic`, a prerendered version of this page
 * would freeze whatever the flag read at build time into the served HTML,
 * and flipping the env var afterward would neither open nor close the route
 * at runtime.
 *
 * Route protection: `/articles/new-blog` is not a distinct entry in
 * `ADMIN_PAGE_ROOTS` (`src/server/auth/registry.ts`) — it is already
 * covered by the registered `/articles` root, whose `resolveAdminPage`
 * match is prefix-based (`segmentMatch`: exact or `${root}/`-prefixed), the
 * same way `/articles/[articleId]` already relies on that same prefix match
 * without its own root entry. The plan explicitly calls this out as
 * something to "显式复核一次" rather than assume —
 * `tests/ui/articles-new-blog-entry.test.ts` asserts
 * `resolveAdminPage("/articles/new-blog") === "/articles"` directly so this
 * stays checked, not just believed.
 */
export const dynamic = "force-dynamic";

export default async function NewBlogArticlePage() {
  if (!isArticleBlogEnabled(process.env)) notFound();

  const { context, granted } = await requireContentPage("/articles/new-blog", "content:publish");

  return (
    <AdminShell
      session={sessionView(context)}
      title="新建博客文章"
      description="本入口固定创建博客文章，不需要选择书目或模板。"
      actions={
        <Link
          href="/articles"
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          返回文章列表
        </Link>
      }
    >
      {granted ? (
        <BlogCreateForm />
      ) : (
        <ContentCapabilityDenied capability="content:publish" />
      )}
    </AdminShell>
  );
}
