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
  const article = await prisma.article.findFirst({ where: { id: articleId, deletedAt: null }, select: { id: true, title: true, summary: true, body: true, seoMetadata: true, slug: true, publicPageShortId: true } });
  if (!article) notFound();
  const canWrite = findCapabilityState(capabilityViews(context), "content:publish") === "granted";
  return <AdminShell session={sessionView(context)} title={`编辑文章 · ${article.title}`} description="预览并保存运营正文与文章级 SEO 元数据。"><ArticleEditor article={article} canWrite={canWrite} /></AdminShell>;
}
