import Link from "next/link";
import { notFound } from "next/navigation";
import { findCapabilityState } from "@/features/admin-ui/capability-view";

import { prisma } from "../../../api/admin/_lib/deps";
import { AdminShell } from "../../_components/admin-shell";
import { capabilityViews, sessionView } from "../../_lib/page-guard";
import { requireContentPage } from "../../novels/_lib/content-page-guard";
import { ArticleEditor } from "../_components/article-editor";

export const dynamic = "force-dynamic";

/**
 * C-23 (`分析_文章管理Parity缺口_2026-09-08.md` §六): navigation closure's
 * remaining leg. The novel-detail page has had a "查看该书目的文章" link
 * into `/articles?novelId=…` since C-19, and the article *list*'s 书目
 * column has linked back to `/novels/{novelId}` since C-20 — but this edit
 * page, the screen an operator actually lands on after clicking "编辑/预览"
 * from that list, had no way back to either the list or the book short of
 * the browser's own Back button. `novel: { select: { id: true, title: true } }`
 * is a plain relation include, not a new query.
 *
 * C-27: `Article.novelId`/`novel` are nullable as of this round (blog
 * articles have no Novel — this page does not build a blog editor yet, that
 * is C-28, but any Article row this query can load may now legitimately have
 * a null `novel`). The "查看所属书目" link is therefore rendered only when
 * `article.novel` is present; every existing row today is `novel_article`
 * with a Novel, so this is a no-op for all of them.
 */
export default async function ArticleEditPage({ params }: { params: Promise<{ articleId: string }> }) {
  const { articleId } = await params;
  const { context, granted } = await requireContentPage("/articles/[articleId]", "content:view");
  if (!granted) notFound();
  const article = await prisma.article.findFirst({
    where: { id: articleId, deletedAt: null },
    select: {
      id: true,
      title: true,
      summary: true,
      body: true,
      seoMetadata: true,
      slug: true,
      publicPageShortId: true,
      // C-25: read by `ArticleEditor`'s three-pill SEO 可见性 selector below.
      seoVisibility: true,
      // C-26: read-only 类型/内容模式 display line below — see that
      // component's own doc comment on why these are display-only here
      // (system-observed facts, not operator-facing form fields).
      articleType: true,
      contentMode: true,
      updatedAt: true,
      novel: { select: { id: true, title: true } },
    },
  });
  if (!article) notFound();
  const canWrite = findCapabilityState(capabilityViews(context), "content:publish") === "granted";
  const updatedAt = article.updatedAt.toISOString();
  // Keyed by `updatedAt` (N-7): a `router.refresh()` after save/conflict
  // re-runs this server component with a fresh row, and the new key remounts
  // `ArticleEditor` so its optimistic-lock state and `defaultValue` fields
  // pick up the fresh row instead of a stale one from the first mount — see
  // that component's doc comment.
  return (
    <AdminShell
      session={sessionView(context)}
      title={`编辑文章 · ${article.title}`}
      description="预览并保存运营正文与文章级 SEO 元数据。"
      actions={
        <div className="flex gap-2">
          {article.novel ? (
            <Link
              href={`/novels/${article.novel.id}`}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              查看所属书目
            </Link>
          ) : null}
          <Link
            href="/articles"
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            返回文章列表
          </Link>
        </div>
      }
    >
      <ArticleEditor key={updatedAt} article={{ ...article, updatedAt }} canWrite={canWrite} />
    </AdminShell>
  );
}
