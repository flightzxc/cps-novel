import Link from "next/link";
import { notFound } from "next/navigation";

import { isArticleNovelRebindEnabled } from "@/lib/flags";

import { AdminShell } from "../../_components/admin-shell";
import { sessionView } from "../../_lib/page-guard";
import { ContentCapabilityDenied } from "../../novels/_components/content-states";
import { requireContentPage } from "../../novels/_lib/content-page-guard";
import { BatchRebindClient } from "./_components/batch-rebind-client";

/**
 * C-30B (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4B.4). Batch "换小说"
 * entry page — CPS structure ADAPTed (`batch-drama-switch-v2-client.tsx`,
 * 1011 lines): 分面选择 → 生成有界预览 → 四页签 → 卡片列表 → 勾选 → 确认对话框
 * → 批次详情 → 续跑.
 *
 * Same `force-dynamic` + `notFound()` kill-switch shape as
 * `../new-blog/page.tsx` (施工工单 §4B.4: "总闸关闭时页面 404（force-dynamic +
 * 页面级开关，形态照新建博客页）"). Route protection: NOT a distinct entry in
 * `ADMIN_PAGE_ROOTS` — covered by the registered `/articles` root's prefix
 * match, same as `/articles/new-blog` and `/articles/[articleId]`; see
 * `tests/ui/batch-novel-rebind-page.test.tsx`'s explicit
 * `resolveAdminPage("/articles/batch-novel-rebind") === "/articles"`
 * assertion (施工工单's own "必须有一条测试显式断言这一点，沿用新建博客页的
 * 先例").
 */
export const dynamic = "force-dynamic";

export default async function BatchNovelRebindPage() {
  if (!isArticleNovelRebindEnabled(process.env)) notFound();

  const { context, granted } = await requireContentPage("/articles/batch-novel-rebind", "content:batch-rebind");

  return (
    <AdminShell
      session={sessionView(context)}
      title="批量换小说"
      description="按渠道故障切换场景批量迁移文章绑定：先按语种生成有界预览，确认后再提交执行。"
      actions={
        <Link
          href="/articles"
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          返回文章列表
        </Link>
      }
    >
      {granted ? <BatchRebindClient /> : <ContentCapabilityDenied capability="content:batch-rebind" />}
    </AdminShell>
  );
}
