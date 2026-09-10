"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { buttonClassName } from "@/components/ui/button";
import { EmptyRow, TBody, TD, TH, THead, Table } from "@/components/ui/table";
import { templateErrorCopy } from "@/features/admin-ui/error-copy";
import { SITE_LOCALES, SITE_LOCALE_LABELS, type SiteLocale } from "@/lib/locale/locale-canonical";
import { REGISTERED_TEMPLATE_FIELDS } from "@/lib/seo/template/fields";
import { isArticleContentBlockList } from "@/lib/article-templates/content-blocks";
import { APPLICABLE_ARTICLE_TYPES, type ApplicableArticleType } from "@/lib/article-templates/applicable-article-type";
import { DEFAULT_ARTICLE_TEMPLATE_KEY } from "@/lib/article-templates/default-template-key";
import type { ArticleTemplateStatus, ArticleTemplateWrite } from "@/lib/article-templates/contract";

import { BlockEditor, insertPlaceholderAtCursor, type ContentBlock } from "./block-editor";
import { createTemplateAction, deleteTemplateAction, setTemplateStatusAction, updateTemplateAction } from "../_actions";

/**
 * P2-02B UI parity pass. Ported from CPS `template-form.tsx` (566 lines,
 * read-only reference) into this project's four-card layout, on top of the
 * P2-02B write contract (`service.ts`'s `ArticleTemplateWrite`): `version`
 * is gone from the form entirely (auto-assigned server-side), and
 * `bodyTemplate` is derived from `contentTemplate` (a structured block
 * array edited via `BlockEditor`, `./block-editor.tsx`) rather than typed
 * in free-form.
 */

export type TemplateRow = {
  id: string;
  templateKey: string;
  templateName: string;
  /** L10N P3: `ArticleTemplate.locale` is `NOT NULL` now — no more "all locales" `null`. */
  locale: string;
  version: number;
  schemaVersion: number;
  status: string;
  applicableArticleType: string;
  bodyTemplate: string;
  contentTemplate: unknown;
  seoTemplate: unknown;
  slugTemplate: string;
  metaKeywordsTemplate: string;
  articleCount: number;
};

const STATUS_OPTIONS = ["draft", "active", "inactive"] as const;

const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  draft: "草稿",
  active: "启用",
  inactive: "停用",
});

const APPLICABLE_ARTICLE_TYPE_LABELS: Readonly<Record<ApplicableArticleType, string>> = Object.freeze({
  novel_article: "小说文章",
  blog_article: "普通博客",
  listicle: "榜单文章",
  guide: "阅读指南",
  any: "通用模板",
});

function seo(row?: TemplateRow) {
  const value = row?.seoTemplate;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function localeLabel(locale: string): string {
  return SITE_LOCALE_LABELS[locale as SiteLocale] ?? locale;
}

function applicableArticleTypeLabel(value: string): string {
  return APPLICABLE_ARTICLE_TYPE_LABELS[value as ApplicableArticleType] ?? value;
}

/** `contentTemplate` from the DB → editable `ContentBlock[]`. Anything that doesn't parse as a valid block list (should not happen — `storage()` rejects it at write time) renders as empty rather than throwing. */
function parseBlocks(value: unknown): ContentBlock[] {
  if (!isArticleContentBlockList(value)) return [];
  return value.map((block, index) => ({ id: `existing_${index}`, type: block.type, content: block.content }));
}

/**
 * `{key}` → `[中文 label]`, and unwraps `{if x}…{endif}` to its inner text.
 * Pure client-side substitution mirroring CPS `template-form.tsx:117-130`'s
 * `previewText` — no server round-trip, no real variable values.
 */
function previewText(template: string): string {
  if (!template) return "";
  let text = template;
  for (const field of REGISTERED_TEMPLATE_FIELDS) {
    text = text.replaceAll(`{${field.key}}`, `[${field.label}]`);
  }
  text = text.replace(/\{if\s+\w+\}([\s\S]*?)\{endif\}/g, (_match, inner: string) => inner);
  return text;
}

export function TemplateManager({ rows, canWrite }: { rows: readonly TemplateRow[]; canWrite: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState<TemplateRow | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Controlled state only for the fields that need cursor-aware quick-insert
  // or a live client-side preview. Everything else stays a plain
  // uncontrolled `<input name=...>`/`<select name=...>` read via
  // `formData.get(...)` in `submit`, matching this file's existing
  // convention (and CPS's own split between controlled title/blocks and
  // uncontrolled basic-info/SEO fields).
  const [titleTemplate, setTitleTemplate] = useState("{novel_title}");
  const [blocks, setBlocks] = useState<ContentBlock[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  function openEditor(row: TemplateRow | null) {
    setError(null);
    setTitleTemplate(row ? String(seo(row).title ?? "") : "{novel_title}");
    setBlocks(row ? parseBlocks(row.contentTemplate) : []);
    setShowPreview(false);
    setEditing(row);
  }

  function insertTitleWildcard(key: string) {
    const input = titleInputRef.current;
    if (!input) return;
    const { value, caret } = insertPlaceholderAtCursor(input, `{${key}}`);
    setTitleTemplate(value);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(caret, caret);
    });
  }

  async function submit(formData: FormData) {
    if (blocks.length === 0) {
      setError("template_content_invalid");
      return;
    }
    setError(null);
    setPending(true);
    // L10N P3: no more "" → null ("all locales") coercion — the `<select
    // required>` above always submits a `SITE_LOCALES` member; `service.ts`'s
    // `requireLocale` still rejects anything that isn't one, this just stops
    // pre-empting that with a silent-null fallback the server no longer accepts.
    const rawLocale = String(formData.get("locale") ?? "").trim();
    const template: ArticleTemplateWrite = {
      templateKey: String(formData.get("templateKey") ?? ""),
      templateName: String(formData.get("templateName") ?? ""),
      locale: rawLocale,
      status: String(formData.get("status") ?? "draft") as ArticleTemplateStatus,
      applicableArticleType: String(formData.get("applicableArticleType") ?? "novel_article"),
      titleTemplate,
      contentTemplate: blocks.map(({ type, content }) => ({ type, content })),
      slugTemplate: String(formData.get("slugTemplate") ?? ""),
      metaKeywordsTemplate: String(formData.get("metaKeywordsTemplate") ?? ""),
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
    const isBuiltinDefault = editing?.templateKey === DEFAULT_ARTICLE_TEMPLATE_KEY;
    return (
      <form action={submit} className="space-y-6">
        <h2 className="text-lg font-semibold">{editing ? "编辑模板" : "新建模板"}</h2>

        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {templateErrorCopy(error)}
          </p>
        )}

        {isBuiltinDefault && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            这是内置默认模板（{DEFAULT_ARTICLE_TEMPLATE_KEY}）。它当前的正文是手写 HTML，与下方内容区块编辑器编译出的结果不是逐字节相同——缺少
            &lt;article&gt; 外壳、标题标签是 &lt;h1&gt;、图片带 alt=&quot;Cover&quot; 等细节。
            <strong>点击“保存并校验”会把正文替换成按区块重新编译的版本</strong>
            ，如果只是想查看原始内容，请直接点击下方“取消”离开，不要保存。
          </p>
        )}

        {/* 基本信息 */}
        <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="border-b border-gray-100 pb-2 font-semibold text-gray-900">基本信息</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              模板 Key
              <input
                name="templateKey"
                defaultValue={editing?.templateKey}
                required
                disabled={Boolean(editing)}
                className="mt-1 w-full rounded border p-2 disabled:bg-gray-100 disabled:text-gray-500"
              />
            </label>
            <label className="text-sm">
              模板名称
              <input name="templateName" defaultValue={editing?.templateName} required className="mt-1 w-full rounded border p-2" />
            </label>
            <label className="text-sm">
              状态
              <select name="status" defaultValue={editing?.status ?? "draft"} className="mt-1 w-full rounded border p-2">
                {STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              模板语种
              {/*
               * L10N P3: `locale` 不再有"全部语种"这个第三态——`ArticleTemplate.locale`
               * 现在是 `NOT NULL`，选项收窄成 `SITE_LOCALES` 15 项（CPS 参照
               * `3a76877:src/components/templates/template-form.tsx:251-258` 的
               * `TEMPLATE_LOCALE_OPTIONS` 是 17 项，含 CPS 的 `pt`/`zh-TW` 别名折叠，
               * 本仓不抄，登记表 15 项即 `SITE_LOCALES` 本身），`required` 与 CPS 同款。
               */}
              <select
                name="locale"
                defaultValue={editing?.locale ?? SITE_LOCALES[0]}
                required
                className="mt-1 w-full rounded border p-2"
              >
                {SITE_LOCALES.map((locale) => (
                  <option key={locale} value={locale}>
                    {SITE_LOCALE_LABELS[locale]}
                  </option>
                ))}
              </select>
            </label>
            <div className="text-sm sm:col-span-2">
              <label>
                适用文章类型
                <select
                  name="applicableArticleType"
                  defaultValue={editing?.applicableArticleType ?? "novel_article"}
                  className="mt-1 w-full rounded border p-2"
                >
                  {APPLICABLE_ARTICLE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {APPLICABLE_ARTICLE_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </label>
              <p className="mt-1 text-xs text-gray-400">生成文章页会按文章类型过滤模板；通用模板可用于所有类型。</p>
            </div>
          </div>
        </div>

        {/* 标题模板 */}
        <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="border-b border-gray-100 pb-2 font-semibold text-gray-900">标题模板</h3>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-400">快速插入（光标位置）：</span>
            {REGISTERED_TEMPLATE_FIELDS.map((field) => (
              <button
                key={field.key}
                type="button"
                onClick={() => insertTitleWildcard(field.key)}
                title={field.description}
                className="rounded bg-orange-50 px-2 py-0.5 text-xs text-orange-600 hover:bg-orange-100"
              >
                {`{${field.label}}`}
              </button>
            ))}
          </div>
          <input
            ref={titleInputRef}
            aria-label="标题模板"
            value={titleTemplate}
            onChange={(event) => setTitleTemplate(event.target.value)}
            required
            className="w-full rounded border p-2 font-mono"
          />
          {titleTemplate && <p className="text-xs text-gray-400">预览：{previewText(titleTemplate)}</p>}
        </div>

        {/* 内容区块 */}
        <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex items-center justify-between border-b border-gray-100 pb-2">
            <h3 className="font-semibold text-gray-900">内容区块</h3>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">{blocks.length} 个区块</span>
              <button
                type="button"
                onClick={() => setShowPreview((value) => !value)}
                className={`rounded-lg px-3 py-1 text-xs font-medium ${
                  showPreview ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {showPreview ? "关闭预览" : "预览"}
              </button>
            </div>
          </div>
          {showPreview ? (
            <BlockPreview title={titleTemplate} blocks={blocks} />
          ) : (
            <BlockEditor blocks={blocks} onChange={setBlocks} variableFields={REGISTERED_TEMPLATE_FIELDS} />
          )}
        </div>

        {/* SEO 元数据模板 */}
        <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="border-b border-gray-100 pb-2 font-semibold text-gray-900">SEO 元数据模板</h3>
          <label className="block text-sm">
            Slug 模板
            <input
              name="slugTemplate"
              defaultValue={editing?.slugTemplate ?? ""}
              placeholder="留空则自动从标题生成 slug"
              className="mt-1 w-full rounded border p-2 font-mono"
            />
          </label>
          <label className="block text-sm">
            Meta Title 模板
            <input
              name="metaTitleTemplate"
              defaultValue={String(values.metaTitle ?? "")}
              placeholder="留空则使用标题模板"
              className="mt-1 w-full rounded border p-2 font-mono"
            />
          </label>
          <label className="block text-sm">
            Meta Description 模板
            <textarea
              name="metaDescriptionTemplate"
              defaultValue={String(values.metaDescription ?? "")}
              rows={3}
              className="mt-1 w-full rounded border p-2 font-mono"
            />
          </label>
          <label className="block text-sm">
            Meta Keywords 模板
            <input
              name="metaKeywordsTemplate"
              defaultValue={editing?.metaKeywordsTemplate ?? ""}
              className="mt-1 w-full rounded border p-2 font-mono"
            />
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClassName("secondary")} onClick={() => setEditing(undefined)}>
            取消
          </button>
          <button disabled={pending || !canWrite} className={buttonClassName("primary")}>
            {pending ? "保存中…" : "保存并校验"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button disabled={!canWrite} className={buttonClassName("primary")} onClick={() => openEditor(null)}>
          新建模板
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {templateErrorCopy(error)}
        </p>
      )}
      <Table>
        <THead>
          <tr>
            <TH>模板 Key / 语种</TH>
            <TH>模板名称</TH>
            <TH>适用文章类型</TH>
            <TH>版本</TH>
            <TH>状态</TH>
            <TH>使用数</TH>
            <TH>操作</TH>
          </tr>
        </THead>
        <TBody>
          {rows.map((row) => (
            <tr key={row.id}>
              <TD>
                <p className="font-medium">{row.templateKey}</p>
                <p className="text-xs text-gray-500">{localeLabel(row.locale)}</p>
              </TD>
              <TD>{row.templateName}</TD>
              <TD>{applicableArticleTypeLabel(row.applicableArticleType)}</TD>
              <TD>{row.version}</TD>
              <TD>{STATUS_LABELS[row.status] ?? row.status}</TD>
              <TD>{row.articleCount}</TD>
              <TD>
                <div className="flex flex-wrap gap-2">
                  <button className={buttonClassName("secondary", "px-2 py-1 text-xs")} onClick={() => openEditor(row)}>
                    编辑
                  </button>
                  <button
                    disabled={!canWrite || pending}
                    className={buttonClassName("secondary", "px-2 py-1 text-xs")}
                    onClick={() =>
                      void mutate(() =>
                        setTemplateStatusAction({
                          requestId: crypto.randomUUID(),
                          id: row.id,
                          status: row.status === "active" ? "inactive" : "active",
                        }),
                      )
                    }
                  >
                    {row.status === "active" ? "停用" : "启用"}
                  </button>
                  <button
                    disabled={!canWrite || pending || row.articleCount > 0}
                    className={buttonClassName("danger", "px-2 py-1 text-xs")}
                    onClick={() => void mutate(() => deleteTemplateAction({ requestId: crypto.randomUUID(), id: row.id }))}
                  >
                    删除
                  </button>
                </div>
              </TD>
            </tr>
          ))}
          {rows.length === 0 && <EmptyRow colSpan={7}>暂无模板；首次创建内容时会自动建立 system-default-v1。</EmptyRow>}
        </TBody>
      </Table>
    </div>
  );
}

/** Read-only preview of title + blocks, substituting `{field}` → `[中文 label]`. Mirrors CPS `template-form.tsx`'s `TemplatePreview` (492-566). */
function BlockPreview({ title, blocks }: { title: string; blocks: ContentBlock[] }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-6">
      <div className="mx-auto max-w-2xl space-y-4 rounded-lg bg-white p-6 shadow-sm">
        {title && <h1 className="border-b pb-3 text-2xl font-bold text-gray-900">{previewText(title)}</h1>}
        {blocks.map((block) => {
          const text = previewText(block.content);
          switch (block.type) {
            case "heading":
              return (
                <h2 key={block.id} className="text-lg font-semibold text-gray-800">
                  {text || "（空标题）"}
                </h2>
              );
            case "paragraph":
              return (
                <p key={block.id} className="whitespace-pre-wrap text-sm leading-relaxed text-gray-600">
                  {text || "（空段落）"}
                </p>
              );
            case "cta":
              return (
                <div key={block.id} className="py-2 text-center">
                  <span className="inline-block rounded-lg bg-blue-600 px-6 py-2 text-sm font-medium text-white">{text || "CTA 按钮"}</span>
                </div>
              );
            case "image":
              return (
                <div key={block.id} className="rounded-lg border border-gray-200 bg-gray-100 p-4 text-center text-xs text-gray-400">
                  封面图（无封面图时不渲染）
                </div>
              );
            case "divider":
              return <hr key={block.id} className="border-gray-200" />;
            default:
              return null;
          }
        })}
        {blocks.length === 0 && <p className="py-8 text-center text-gray-400">暂无内容区块</p>}
      </div>
    </div>
  );
}
