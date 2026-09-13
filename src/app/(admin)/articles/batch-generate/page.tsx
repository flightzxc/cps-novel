import Link from "next/link";

import { findCapabilityState } from "@/features/admin-ui/capability-view";
import { listActiveArticleTemplateOptionsForLocales } from "@/server/article-templates";
import { listNovelsForArticleGenerate } from "@/server/content-creation";

import { prisma } from "../../../api/admin/_lib/deps";
import { AdminShell } from "../../_components/admin-shell";
import { capabilityViews, sessionView } from "../../_lib/page-guard";
import { ContentCapabilityDenied } from "../../novels/_components/content-states";
import { requireContentPage } from "../../novels/_lib/content-page-guard";
import { ArticleBatchGenerateForm } from "./_components/batch-generate-form";

export const dynamic = "force-dynamic";

export default async function ArticleBatchGeneratePage() {
  const { context, granted } = await requireContentPage("/articles/batch-generate", "content:view");
  const canWrite = findCapabilityState(capabilityViews(context), "content:publish") === "granted";

  if (!granted) {
    return (
      <AdminShell session={sessionView(context)} title="批量创建文章">
        <ContentCapabilityDenied capability="content:view" />
      </AdminShell>
    );
  }

  const initialPage = await listNovelsForArticleGenerate(prisma, {
    page: 1,
    pageSize: 50,
    eligibleOnly: true,
  });
  const locales = Array.from(new Set(initialPage.rows.map((row) => row.locale)));
  const templates = locales.length > 0
    ? await listActiveArticleTemplateOptionsForLocales(prisma, locales, "novel_article")
    : [];

  return (
    <AdminShell
      session={sessionView(context)}
      title="批量创建文章"
      description="为尚未建稿的书目排队创建文章。已有文章请使用列表页的「批量再生成」。"
      actions={
        <div className="flex gap-2">
          <Link href="/articles/generate" className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
            单篇创建文章
          </Link>
          <Link href="/articles" className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
            返回文章列表
          </Link>
        </div>
      }
    >
      <ArticleBatchGenerateForm initialPage={initialPage} templates={templates} canWrite={canWrite} />
    </AdminShell>
  );
}
