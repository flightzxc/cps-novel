"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClassName } from "@/components/ui/button";
import { updateArticleAction } from "../_actions";

export function ArticleEditor({ article, canWrite }: { article: { id: string; title: string; summary: string | null; body: string; seoMetadata: unknown; slug: string; publicPageShortId: string }; canWrite: boolean }) {
  const router = useRouter();
  const meta = article.seoMetadata && typeof article.seoMetadata === "object" && !Array.isArray(article.seoMetadata) ? article.seoMetadata as Record<string, unknown> : {};
  const [preview, setPreview] = useState(article.body);
  const [message, setMessage] = useState<string | null>(null);
  async function submit(formData: FormData) {
    const body = String(formData.get("body") ?? "");
    const result = await updateArticleAction({ requestId: crypto.randomUUID(), articleId: article.id, patch: {
      title: String(formData.get("title") ?? ""), summary: String(formData.get("summary") ?? ""), body,
      metaTitle: String(formData.get("metaTitle") ?? ""), metaDescription: String(formData.get("metaDescription") ?? ""),
    } });
    setMessage(result.ok ? "已保存；slug 与 shortId 保持不变。" : result.code);
    setPreview(body);
    if (result.ok) router.refresh();
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
