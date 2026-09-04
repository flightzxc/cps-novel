import { findCapabilityState } from "@/features/admin-ui/capability-view";

import { prisma } from "../../api/admin/_lib/deps";
import { AdminShell } from "../_components/admin-shell";
import { capabilityViews, sessionView } from "../_lib/page-guard";
import { ContentCapabilityDenied } from "../novels/_components/content-states";
import { requireContentPage } from "../novels/_lib/content-page-guard";
import { ArticleList } from "./_components/article-list";

export const dynamic = "force-dynamic";

export default async function ArticlesPage() {
  const { context, granted } = await requireContentPage("/articles", "content:view");
  const canWrite = findCapabilityState(capabilityViews(context), "content:publish") === "granted";
  const rows = granted ? await prisma.article.findMany({ where: { deletedAt: null }, take: 200, orderBy: { updatedAt: "desc" }, select: { id: true, title: true, locale: true, slug: true, publicPageShortId: true, status: true, summary: true, updatedAt: true, template: { select: { templateKey: true } } } }) : [];
  return <AdminShell session={sessionView(context)} title="文章管理" description="编辑文章正文与 SEO 元数据，或在 50 条/25 秒预算内批量再生成。">{granted ? <ArticleList canWrite={canWrite} rows={rows.map((row) => ({ ...row, templateKey: row.template?.templateKey ?? null, updatedAt: row.updatedAt.toISOString() }))} /> : <ContentCapabilityDenied capability="content:view" />}</AdminShell>;
}
