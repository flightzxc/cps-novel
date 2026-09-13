import Link from "next/link";

import { findCapabilityState } from "@/features/admin-ui/capability-view";
import { listActiveArticleTemplateOptionsForLocales } from "@/server/article-templates";
import { listNovelsForArticleGenerate } from "@/server/content-creation";

import { prisma } from "../../../api/admin/_lib/deps";
import { AdminShell } from "../../_components/admin-shell";
import { capabilityViews, sessionView } from "../../_lib/page-guard";
import { ContentCapabilityDenied } from "../../novels/_components/content-states";
import { requireContentPage } from "../../novels/_lib/content-page-guard";
import { ArticleGenerateForm } from "./_components/generate-form";

export const dynamic = "force-dynamic";

export default async function ArticleGeneratePage({
  searchParams,
}: {
  searchParams: Promise<{ novelId?: string; search?: string; locale?: string }>;
}) {
  const query = await searchParams;
  const { context, granted } = await requireContentPage("/articles/generate", "content:view");
  const canWrite = findCapabilityState(capabilityViews(context), "content:publish") === "granted";

  if (!granted) {
    return (
      <AdminShell session={sessionView(context)} title="创建文章">
        <ContentCapabilityDenied capability="content:view" />
      </AdminShell>
    );
  }

  const novels = await listNovelsForArticleGenerate(prisma, {
    search: query.search,
    locale: query.locale,
    limit: 80,
  });
  const locales = Array.from(new Set(novels.map((row) => row.locale)));
  const templates = locales.length > 0
    ? await listActiveArticleTemplateOptionsForLocales(prisma, locales, "novel_article")
    : [];

  return (
    <AdminShell
      session={sessionView(context)}
      title="创建文章"
      description="选择已纳入的书目和文章模板。必须已有就绪推广链接。"
      actions={
        <div className="flex gap-2">
          <Link href="/articles/batch-generate" className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
            批量创建文章
          </Link>
          <Link href="/articles" className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
            返回文章列表
          </Link>
        </div>
      }
    >
      <ArticleGenerateForm
        novels={novels}
        templates={templates}
        canWrite={canWrite}
        initialNovelId={query.novelId}
      />
    </AdminShell>
  );
}
