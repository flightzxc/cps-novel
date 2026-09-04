"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { buttonClassName } from "@/components/ui/button";
import { EmptyRow, TBody, TD, TH, THead, Table } from "@/components/ui/table";
import { buildArticlePath } from "@/lib/slug/article-path";

import { regenerateArticleAction, regenerateArticlesBatchAction } from "../_actions";

export type ArticleListRow = { id: string; title: string; locale: string; slug: string; publicPageShortId: string; status: string; summary: string | null; templateKey: string | null; updatedAt: string };

export function ArticleList({ rows, canWrite }: { rows: readonly ArticleListRow[]; canWrite: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  async function batch() {
    const result = await regenerateArticlesBatchAction({ requestId: crypto.randomUUID(), articleIds: [...selected] });
    setMessage(result.ok ? `再生成完成：成功 ${result.data.counts.regenerated}，跳过 ${result.data.counts.skipped}，失败 ${result.data.counts.failed}，未处理 ${result.data.counts.not_processed}` : result.code);
    if (result.ok) { setSelected(new Set()); router.refresh(); }
  }
  return <div className="space-y-4">
    <div className="flex items-center justify-between"><p className="text-sm text-gray-600">已选择 {selected.size} / 50</p><button disabled={!canWrite || selected.size === 0 || selected.size > 50} className={buttonClassName("primary")} onClick={() => void batch()}>批量再生成</button></div>
    {message && <p role="status" className="rounded border bg-gray-50 p-3 text-sm">{message}</p>}
    <Table><THead><tr><TH /><TH>文章</TH><TH>状态</TH><TH>模板</TH><TH>操作</TH></tr></THead><TBody>
      {rows.map((row) => <tr key={row.id}><TD><input type="checkbox" aria-label={`选择 ${row.title}`} checked={selected.has(row.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; })} /></TD><TD><p className="font-medium">{row.title}</p><p className="line-clamp-2 text-xs text-gray-500">{row.summary ?? "无摘要"}</p></TD><TD>{row.status}</TD><TD>{row.templateKey ?? "未绑定"}</TD><TD><div className="flex gap-2"><Link href={`/articles/${row.id}`} className={buttonClassName("secondary", "px-2 py-1 text-xs")}>编辑/预览</Link>{row.status === "published" && <a target="_blank" rel="noreferrer" href={buildArticlePath({ locale: row.locale as "en", slug: row.slug, shortId: row.publicPageShortId })} className={buttonClassName("secondary", "px-2 py-1 text-xs")}>公开页</a>}<button disabled={!canWrite} className={buttonClassName("secondary", "px-2 py-1 text-xs")} onClick={() => void regenerateArticleAction({ requestId: crypto.randomUUID(), articleId: row.id }).then((result) => { setMessage(result.ok ? result.data.outcome : result.code); router.refresh(); })}>再生成</button></div></TD></tr>)}
      {rows.length === 0 && <EmptyRow colSpan={5}>暂无文章</EmptyRow>}
    </TBody></Table>
  </div>;
}
