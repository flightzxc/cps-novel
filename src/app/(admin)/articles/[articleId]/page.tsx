import { notFound } from "next/navigation";
import { findCapabilityState } from "@/features/admin-ui/capability-view";

import { prisma } from "../../../api/admin/_lib/deps";
import { AdminShell } from "../../_components/admin-shell";
import { capabilityViews, sessionView } from "../../_lib/page-guard";
import { requireContentPage } from "../../novels/_lib/content-page-guard";
import { ArticleEditor } from "../_components/article-editor";

export const dynamic = "force-dynamic";

export default async function ArticleEditPage({ params }: { params: Promise<{ articleId: string }> }) {
  const { articleId } = await params;
  const { context, granted } = await requireContentPage("/articles/[articleId]", "content:view");
  if (!granted) notFound();
  const article = await prisma.article.findFirst({ where: { id: articleId, deletedAt: null }, select: { id: true, title: true, summary: true, body: true, seoMetadata: true, slug: true, publicPageShortId: true, updatedAt: true } });
  if (!article) notFound();
  const canWrite = findCapabilityState(capabilityViews(context), "content:publish") === "granted";
  const updatedAt = article.updatedAt.toISOString();
  // Keyed by `updatedAt` (N-7): a `router.refresh()` after save/conflict
  // re-runs this server component with a fresh row, and the new key remounts
  // `ArticleEditor` so its optimistic-lock state and `defaultValue` fields
  // pick up the fresh row instead of a stale one from the first mount — see
  // that component's doc comment.
  return <AdminShell session={sessionView(context)} title={`编辑文章 · ${article.title}`} description="预览并保存运营正文与文章级 SEO 元数据。"><ArticleEditor key={updatedAt} article={{ ...article, updatedAt }} canWrite={canWrite} /></AdminShell>;
}
