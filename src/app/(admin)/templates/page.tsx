import { findCapabilityState } from "@/features/admin-ui/capability-view";
import { listArticleTemplates } from "@/server/article-templates";

import { prisma } from "../../api/admin/_lib/deps";
import { AdminShell } from "../_components/admin-shell";
import { capabilityViews, sessionView } from "../_lib/page-guard";
import { ContentCapabilityDenied } from "../novels/_components/content-states";
import { requireContentPage } from "../novels/_lib/content-page-guard";
import { TemplateManager } from "./_components/template-manager";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const { context, granted } = await requireContentPage("/templates", "content:view");
  const canWrite = findCapabilityState(capabilityViews(context), "content:publish") === "granted";
  const templates = granted ? await listArticleTemplates(prisma) : [];
  return <AdminShell session={sessionView(context)} title="模板管理" description="维护文章模板、启停版本并使用既有引擎进行 fail-closed 校验。">
    {granted ? <TemplateManager canWrite={canWrite} rows={templates.map((row) => ({ ...row, seoTemplate: row.seoTemplate, articleCount: row._count.articles }))} /> : <ContentCapabilityDenied capability="content:view" />}
  </AdminShell>;
}
