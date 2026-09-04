"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { buttonClassName } from "@/components/ui/button";
import { EmptyRow, TBody, TD, TH, THead, Table } from "@/components/ui/table";

import { createTemplateAction, deleteTemplateAction, setTemplateStatusAction, updateTemplateAction } from "../_actions";

export type TemplateRow = {
  id: string;
  templateKey: string;
  locale: string | null;
  version: number;
  schemaVersion: number;
  status: string;
  bodyTemplate: string;
  seoTemplate: unknown;
  articleCount: number;
};

function seo(row?: TemplateRow) {
  const value = row?.seoTemplate;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function TemplateManager({ rows, canWrite }: { rows: readonly TemplateRow[]; canWrite: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState<TemplateRow | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(formData: FormData) {
    setPending(true);
    setError(null);
    const template = {
      templateKey: String(formData.get("templateKey") ?? ""),
      locale: String(formData.get("locale") ?? "") || null,
      version: Number(formData.get("version") ?? 1),
      status: String(formData.get("status") ?? "draft") as "draft" | "active" | "inactive",
      titleTemplate: String(formData.get("titleTemplate") ?? ""),
      bodyTemplate: String(formData.get("bodyTemplate") ?? ""),
      metaTitleTemplate: String(formData.get("metaTitleTemplate") ?? ""),
      metaDescriptionTemplate: String(formData.get("metaDescriptionTemplate") ?? ""),
    };
    const requestId = crypto.randomUUID();
    const result = editing
      ? await updateTemplateAction({ requestId, id: editing.id, template })
      : await createTemplateAction({ requestId, template });
    setPending(false);
    if (!result.ok) return setError(result.code);
    setEditing(undefined);
    router.refresh();
  }

  async function mutate(action: () => Promise<{ ok: boolean; code?: string }>) {
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    if (!result.ok) return setError(result.code ?? "template_write_failed");
    router.refresh();
  }

  if (editing !== undefined) {
    const values = seo(editing ?? undefined);
    return (
      <form action={submit} className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="font-semibold">{editing ? "编辑模板" : "新建模板"}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm">模板 Key<input name="templateKey" defaultValue={editing?.templateKey} required className="mt-1 w-full rounded border p-2" /></label>
          <label className="text-sm">Locale<input name="locale" defaultValue={editing?.locale ?? "en"} className="mt-1 w-full rounded border p-2" /></label>
          <label className="text-sm">版本<input name="version" type="number" min="1" defaultValue={editing?.version ?? 1} required className="mt-1 w-full rounded border p-2" /></label>
          <label className="text-sm">状态<select name="status" defaultValue={editing?.status ?? "draft"} className="mt-1 w-full rounded border p-2"><option value="draft">draft</option><option value="active">active</option><option value="inactive">inactive</option></select></label>
        </div>
        <label className="block text-sm">标题模板<input name="titleTemplate" defaultValue={String(values.title ?? "{novel_title}")} required className="mt-1 w-full rounded border p-2 font-mono" /></label>
        <label className="block text-sm">正文模板<textarea name="bodyTemplate" defaultValue={editing?.bodyTemplate ?? "<article><h1>{novel_title}</h1><p>{novel_description}</p></article>"} required rows={8} className="mt-1 w-full rounded border p-2 font-mono" /></label>
        <label className="block text-sm">SEO 标题<input name="metaTitleTemplate" defaultValue={String(values.metaTitle ?? "{novel_title}")} className="mt-1 w-full rounded border p-2 font-mono" /></label>
        <label className="block text-sm">SEO 描述<textarea name="metaDescriptionTemplate" defaultValue={String(values.metaDescription ?? "{novel_description}")} rows={3} className="mt-1 w-full rounded border p-2 font-mono" /></label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className={buttonClassName("secondary")} onClick={() => setEditing(undefined)}>取消</button><button disabled={pending || !canWrite} className={buttonClassName("primary")}>{pending ? "保存中…" : "保存并校验"}</button></div>
      </form>
    );
  }

  return <div className="space-y-4">
    <div className="flex justify-end"><button disabled={!canWrite} className={buttonClassName("primary")} onClick={() => setEditing(null)}>新建模板</button></div>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <Table><THead><tr><TH>Key / Locale</TH><TH>版本</TH><TH>状态</TH><TH>使用数</TH><TH>操作</TH></tr></THead><TBody>
      {rows.map((row) => <tr key={row.id}><TD><p className="font-medium">{row.templateKey}</p><p className="text-xs text-gray-500">{row.locale ?? "全部"}</p></TD><TD>{row.version}</TD><TD>{row.status}</TD><TD>{row.articleCount}</TD><TD><div className="flex flex-wrap gap-2"><button className={buttonClassName("secondary", "px-2 py-1 text-xs")} onClick={() => setEditing(row)}>编辑</button><button disabled={!canWrite || pending} className={buttonClassName("secondary", "px-2 py-1 text-xs")} onClick={() => void mutate(() => setTemplateStatusAction({ requestId: crypto.randomUUID(), id: row.id, status: row.status === "active" ? "inactive" : "active" }))}>{row.status === "active" ? "停用" : "启用"}</button><button disabled={!canWrite || pending || row.articleCount > 0} className={buttonClassName("danger", "px-2 py-1 text-xs")} onClick={() => void mutate(() => deleteTemplateAction({ requestId: crypto.randomUUID(), id: row.id }))}>删除</button></div></TD></tr>)}
      {rows.length === 0 && <EmptyRow colSpan={5}>暂无模板；首次创建内容时会自动建立 system-default-v1。</EmptyRow>}
    </TBody></Table>
  </div>;
}
