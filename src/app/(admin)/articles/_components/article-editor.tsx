"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClassName } from "@/components/ui/button";
import { updateArticleAction } from "../_actions";

/**
 * N-7 optimistic lock: `expectedUpdatedAt` is seeded once from the
 * server-read row via `useState`'s initializer, same `expectedUpdatedAt`
 * round-trip contract as the settings form (`site-settings-client.tsx`).
 * This is a Server Component page (`[articleId]/page.tsx`), not a client
 * fetch like settings, so there is no `adminFetch` re-read to call after a
 * conflict; instead the caller keys this component by `article.updatedAt`
 * (see `[articleId]/page.tsx`) so `router.refresh()` — which re-runs the
 * server component and hands back a fresh row on both a successful save and
 * a conflict — remounts this component with the new value, re-arming the
 * lock and every `defaultValue` field at once rather than requiring a
 * render-phase sync effect for just this one field.
 */
export function ArticleEditor({ article, canWrite }: { article: { id: string; title: string; summary: string | null; body: string; seoMetadata: unknown; slug: string; publicPageShortId: string; updatedAt: string }; canWrite: boolean }) {
  const router = useRouter();
  const meta = article.seoMetadata && typeof article.seoMetadata === "object" && !Array.isArray(article.seoMetadata) ? article.seoMetadata as Record<string, unknown> : {};
  const [preview, setPreview] = useState(article.body);
  const [message, setMessage] = useState<string | null>(null);
  const [expectedUpdatedAt] = useState(article.updatedAt);
  async function submit(formData: FormData) {
    const body = String(formData.get("body") ?? "");
    const result = await updateArticleAction({ requestId: crypto.randomUUID(), articleId: article.id, expectedUpdatedAt, patch: {
      title: String(formData.get("title") ?? ""), summary: String(formData.get("summary") ?? ""), body,
      metaTitle: String(formData.get("metaTitle") ?? ""), metaDescription: String(formData.get("metaDescription") ?? ""),
    } });
    if (!result.ok) {
      setMessage(result.code === "article_conflict" ? "该文章已被其他操作人修改，请刷新后重试。" : result.code);
      router.refresh();
      return;
    }
    setMessage("已保存；slug 与 shortId 保持不变。");
    setPreview(body);
    router.refresh();
  }
  return <div className="grid gap-6 lg:grid-cols-2"><form action={submit} className="space-y-4 rounded-xl border bg-white p-5">
    <label className="block text-sm">标题<input name="title" defaultValue={article.title} required className="mt-1 w-full rounded border p-2" /></label>
    <label className="block text-sm">摘要<textarea name="summary" defaultValue={article.summary ?? ""} rows={4} className="mt-1 w-full rounded border p-2" /></label>
    <label className="block text-sm">正文 HTML<textarea name="body" defaultValue={article.body} required rows={16} className="mt-1 w-full rounded border p-2 font-mono text-xs" onChange={(event) => setPreview(event.target.value)} /></label>
    <label className="block text-sm">SEO 标题<input name="metaTitle" defaultValue={String(meta.metaTitle ?? "")} className="mt-1 w-full rounded border p-2" /></label>
    <label className="block text-sm">SEO 描述<textarea name="metaDescription" defaultValue={String(meta.metaDescription ?? "")} rows={3} className="mt-1 w-full rounded border p-2" /></label>
    <p className="text-xs text-gray-500">slug: {article.slug} · shortId: {article.publicPageShortId}</p>{message && <p role="status" className="text-sm">{message}</p>}
    <button disabled={!canWrite} className={buttonClassName("primary")}>保存</button>
  </form><section className="rounded-xl border bg-white p-5"><h2 className="mb-4 font-semibold">正文预览</h2><div className="prose max-w-none" dangerouslySetInnerHTML={{ __html: preview }} /></section></div>;
}
