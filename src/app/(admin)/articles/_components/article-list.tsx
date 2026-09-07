"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { buttonClassName } from "@/components/ui/button";
import { EmptyRow, TBody, TD, TH, THead, Table } from "@/components/ui/table";
import { buildArticlePath } from "@/lib/slug/article-path";

import { regenerateArticleAction, regenerateArticlesBatchAction } from "../_actions";

export type ArticleListRow = { id: string; title: string; locale: string; slug: string; publicPageShortId: string; status: string; summary: string | null; templateKey: string | null; updatedAt: string };

/**
 * RC-9 admin-host isolation (2026-09-03, Owner): the admin console is served
 * from `ADMIN_CANONICAL_ORIGIN` (e.g. `https://zbcwf.novel.test`), and both
 * `src/proxy.ts` and that host's nginx server block return 404 for every
 * public content path — see `evaluateAdminHostAccess`'s rule table in
 * `@/lib/site/admin-origin`. A site-relative `buildArticlePath` href therefore
 * resolves against the admin origin and 404s, so the public origin has to be
 * spelled out. It is resolved server-side from `SITE_URL` in `../page.tsx`
 * (`process.env.SITE_URL` is not in the client bundle) and threaded down as a
 * prop.
 *
 * `publicOrigin` is `null` only when `SITE_URL` is unset or malformed. The
 * relative fallback then reproduces the pre-RC-9 href, which still works in
 * the dev same-origin branch of the rule table and is no worse than today's
 * link anywhere else — a misconfigured `SITE_URL` must not blank out the
 * whole list.
 */
function publicPageHref(publicOrigin: string | null, row: ArticleListRow): string {
  const path = buildArticlePath({ locale: row.locale as "en", slug: row.slug, shortId: row.publicPageShortId });
  return publicOrigin ? `${publicOrigin}${path}` : path;
}

export function ArticleList({ rows, canWrite, publicOrigin }: { rows: readonly ArticleListRow[]; canWrite: boolean; publicOrigin: string | null }) {
  const router = useRouter();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  function toggleAll() {
    setSelected((current) => { const next = new Set(current); const allVisible = rows.length > 0 && rows.every((r) => next.has(r.id)); if (allVisible) { rows.forEach((r) => next.delete(r.id)); } else { rows.forEach((r) => next.add(r.id)); } return next; });
  }
  async function batch() {
    const result = await regenerateArticlesBatchAction({ requestId: crypto.randomUUID(), articleIds: [...selected] });
    setMessage(result.ok ? `再生成完成：成功 ${result.data.counts.regenerated}，跳过 ${result.data.counts.skipped}，失败 ${result.data.counts.failed}，未处理 ${result.data.counts.not_processed}` : result.code);
    if (result.ok) { setSelected(new Set()); router.refresh(); }
  }
  return <div className="space-y-4">
    <div className="flex items-center justify-between"><p className="text-sm text-gray-600">已选择 {selected.size} / 50</p><button disabled={!canWrite || selected.size === 0 || selected.size > 50} className={buttonClassName("primary")} onClick={() => void batch()}>批量再生成</button></div>
    {message && <p role="status" className="rounded border bg-gray-50 p-3 text-sm">{message}</p>}
    <Table><THead><tr><TH><input type="checkbox" aria-label="选择当前页" checked={allSelected} ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allSelected; }} onChange={toggleAll} /></TH><TH>文章</TH><TH>状态</TH><TH>模板</TH><TH>操作</TH></tr></THead><TBody>
      {rows.map((row) => <tr key={row.id}><TD><input type="checkbox" aria-label={`选择 ${row.title}`} checked={selected.has(row.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; })} /></TD><TD><p className="font-medium">{row.title}</p><p className="line-clamp-2 text-xs text-gray-500">{row.summary ?? "无摘要"}</p></TD><TD>{row.status}</TD><TD>{row.templateKey ?? "未绑定"}</TD><TD><div className="flex gap-2"><Link href={`/articles/${row.id}`} className={buttonClassName("secondary", "px-2 py-1 text-xs")}>编辑/预览</Link>{row.status === "published" && <a target="_blank" rel="noreferrer" href={publicPageHref(publicOrigin, row)} className={buttonClassName("secondary", "px-2 py-1 text-xs")}>公开页</a>}<button disabled={!canWrite} className={buttonClassName("secondary", "px-2 py-1 text-xs")} onClick={() => void regenerateArticleAction({ requestId: crypto.randomUUID(), articleId: row.id, expectedUpdatedAt: row.updatedAt }).then((result) => { setMessage(result.ok ? (result.data.outcome === "conflict" ? "该文章已被其他操作人修改，请刷新后重试。" : result.data.outcome) : result.code); router.refresh(); })}>再生成</button></div></TD></tr>)}
      {rows.length === 0 && <EmptyRow colSpan={5}>暂无文章</EmptyRow>}
    </TBody></Table>
  </div>;
}
