"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";

import {
  ARTICLE_CONTENT_BLOCK_TYPES,
  type ArticleContentBlockType,
} from "@/lib/article-templates/content-blocks";
import type { TemplateFieldDefinition } from "@/lib/seo/template/fields";

/**
 * Content-block editor for the template admin form (P2-02B, CPS parity).
 * Ported from `cps-admin/src/components/templates/block-editor.tsx` (439
 * lines, read-only reference) with three deliberate deviations:
 *
 * - No `dnd-kit` — this repo doesn't depend on it, and CPS's own reorder
 *   handlers are plain HTML5 drag events (CPS :100-139), which is all we
 *   port.
 * - No `lucide-react` — not a dependency here (see
 *   `src/features/admin-ui/icons.tsx`); toolbar buttons use plain text
 *   glyphs instead of icon components.
 * - The `image` block type renders no free-text editor at all. CPS's
 *   `image` content is the actual `<img src>` value, so editing it does
 *   something. This repo's `compileContentBlocks` (`compile-blocks.ts`)
 *   *ignores* `image.content` entirely and always emits a fixed
 *   `{if cover_url}<img src="{cover_url}" alt="" />{endif}` — a deliberate
 *   security fix (CPS's `renderContentBlocks` splices unescaped block
 *   content into `src`). Showing an editable textarea for a field that is
 *   silently dropped on save would be the exact class of bug this whole
 *   pass is trying to remove from the seed template (see
 *   `template-manager.tsx`'s seed-template banner) — so `image` (like
 *   `divider`) gets a static explanatory line instead of a textarea.
 */

export type ContentBlock = {
  /** Client-only identity for React keys / drag tracking — stripped before submit. */
  readonly id: string;
  type: ArticleContentBlockType;
  content: string;
};

const BLOCK_TYPE_LABELS: Readonly<Record<ArticleContentBlockType, string>> = Object.freeze({
  heading: "标题",
  paragraph: "段落",
  cta: "CTA 按钮",
  image: "图片",
  divider: "分隔线",
});

let blockIdCounter = 0;
function generateBlockId(): string {
  blockIdCounter += 1;
  return `block_${Date.now()}_${blockIdCounter}`;
}

export function createEmptyBlock(type: ArticleContentBlockType): ContentBlock {
  return { id: generateBlockId(), type, content: "" };
}

/**
 * Insert `token` at the current caret position of a text input/textarea and
 * return the resulting value plus the caret position right after the
 * inserted text. Pure — callers own the actual `setSelectionRange` restore
 * (has to happen after the state update round-trips through React, so it
 * cannot live inside this function). Shared by this file's block textareas
 * and the title-template quick-insert in `template-manager.tsx` — CPS's own
 * title-card quick insert (`template-form.tsx:322-323`) just appends to the
 * end (`prev + "{...}"`), which is the degraded behaviour this project was
 * told explicitly not to copy.
 */
export function insertPlaceholderAtCursor(
  element: Pick<HTMLInputElement | HTMLTextAreaElement, "value" | "selectionStart" | "selectionEnd">,
  token: string,
): { value: string; caret: number } {
  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? element.value.length;
  const value = element.value.slice(0, start) + token + element.value.slice(end);
  return { value, caret: start + token.length };
}

export function BlockEditor({
  blocks,
  onChange,
  variableFields,
}: {
  blocks: ContentBlock[];
  onChange: (blocks: ContentBlock[]) => void;
  variableFields: readonly TemplateFieldDefinition[];
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  function addBlock(type: ArticleContentBlockType) {
    onChange([...blocks, createEmptyBlock(type)]);
  }

  function updateBlock(index: number, updates: Partial<ContentBlock>) {
    const next = [...blocks];
    next[index] = { ...next[index], ...updates };
    onChange(next);
  }

  function removeBlock(index: number) {
    onChange(blocks.filter((_, i) => i !== index));
  }

  function moveBlock(from: number, to: number) {
    if (from === to) return;
    const next = [...blocks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  }

  function moveUp(index: number) {
    if (index > 0) moveBlock(index, index - 1);
  }

  function moveDown(index: number) {
    if (index < blocks.length - 1) moveBlock(index, index + 1);
  }

  function handleDragStart(index: number) {
    setDragIndex(index);
  }

  function handleDragOver(event: DragEvent, index: number) {
    event.preventDefault();
    setDragOverIndex(index);
  }

  function handleDrop(index: number) {
    if (dragIndex !== null && dragIndex !== index) moveBlock(dragIndex, index);
    setDragIndex(null);
    setDragOverIndex(null);
  }

  function handleDragEnd() {
    setDragIndex(null);
    setDragOverIndex(null);
  }

  return (
    <div className="space-y-3">
      {blocks.map((block, index) => (
        <div
          key={block.id}
          draggable
          onDragStart={() => handleDragStart(index)}
          onDragOver={(event) => handleDragOver(event, index)}
          onDrop={() => handleDrop(index)}
          onDragEnd={handleDragEnd}
          className={`rounded-lg border bg-white transition-colors ${
            dragIndex === index
              ? "border-blue-300 opacity-40"
              : dragOverIndex === index
                ? "border-blue-400 shadow-sm"
                : "border-gray-200"
          }`}
        >
          <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
            <span className="cursor-grab select-none text-gray-300" aria-hidden="true" title="拖动排序">
              ⠿
            </span>
            <select
              aria-label={`区块 ${index + 1} 类型`}
              value={block.type}
              onChange={(event) => {
                const type = event.target.value as ArticleContentBlockType;
                // `image`/`divider` content is ignored at compile time
                // (`compileContentBlocks`) — clear it on switch so a leftover
                // paragraph draft doesn't sit invisibly in `contentTemplate`.
                const content = type === "image" || type === "divider" ? "" : block.content;
                updateBlock(index, { type, content });
              }}
              className="rounded border-0 bg-gray-50 px-2 py-1 text-xs font-medium text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {ARTICLE_CONTENT_BLOCK_TYPES.map((type) => (
                <option key={type} value={type}>
                  {BLOCK_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
            <span className="text-xs text-gray-300">#{index + 1}</span>
            <div className="ml-auto flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => moveUp(index)}
                disabled={index === 0}
                aria-label="上移"
                title="上移"
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30"
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => moveDown(index)}
                disabled={index === blocks.length - 1}
                aria-label="下移"
                title="下移"
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30"
              >
                ▼
              </button>
              <button
                type="button"
                onClick={() => removeBlock(index)}
                aria-label="删除区块"
                title="删除区块"
                className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
              >
                ✕
              </button>
            </div>
          </div>

          {block.type !== "divider" && block.type !== "image" && (
            <BlockContent block={block} index={index} onUpdate={updateBlock} variableFields={variableFields} />
          )}
          {block.type === "image" && (
            <p className="px-3 py-3 text-xs text-gray-400">
              图片区块固定输出封面图（{"{if cover_url}<img src=\"{cover_url}\" alt=\"\" />{endif}"}），无需也无法填写文案内容。
            </p>
          )}
        </div>
      ))}

      {blocks.length === 0 && (
        <div className="rounded-lg border-2 border-dashed border-gray-200 py-10 text-center">
          <p className="text-sm text-gray-400">暂无内容区块</p>
          <p className="mt-1 text-xs text-gray-300">点击下方按钮添加第一个区块；至少需要一个区块才能保存</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-lg border-2 border-dashed border-gray-200 p-3">
        <span className="mr-1 text-xs text-gray-400">添加区块：</span>
        {ARTICLE_CONTENT_BLOCK_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => addBlock(type)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600"
          >
            {BLOCK_TYPE_LABELS[type]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Fields registered `required: false` are the only ones offered as `{if x}…{endif}` chips — see `fields.ts`. */
function conditionalCandidates(fields: readonly TemplateFieldDefinition[]) {
  return fields.filter((field) => field.required === false);
}

function BlockContent({
  block,
  index,
  onUpdate,
  variableFields,
}: {
  block: ContentBlock;
  index: number;
  onUpdate: (index: number, updates: Partial<ContentBlock>) => void;
  variableFields: readonly TemplateFieldDefinition[];
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const insertWildcard = useCallback(
    (key: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const { value, caret } = insertPlaceholderAtCursor(textarea, `{${key}}`);
      onUpdate(index, { content: value });
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
      });
    },
    [index, onUpdate],
  );

  const insertConditional = useCallback(
    (key: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? textarea.value.length;
      const selected = textarea.value.slice(start, end);
      const { value, caret } = insertPlaceholderAtCursor(textarea, `{if ${key}}${selected || "条件内容"}{endif}`);
      onUpdate(index, { content: value });
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
      });
    },
    [index, onUpdate],
  );

  const conditionalFields = conditionalCandidates(variableFields);

  return (
    <div className="px-3 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-gray-400">插入变量（光标位置）：</span>
        {variableFields.map((field) => (
          <button
            key={field.key}
            type="button"
            onClick={() => insertWildcard(field.key)}
            title={field.description}
            className="rounded bg-orange-50 px-2 py-0.5 text-xs text-orange-600 hover:bg-orange-100"
          >
            {`{${field.label}}`}
          </button>
        ))}
      </div>

      {conditionalFields.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-gray-400">条件渲染（字段有值时才显示）：</span>
          {conditionalFields.map((field) => (
            <button
              key={field.key}
              type="button"
              onClick={() => insertConditional(field.key)}
              title={`条件：当${field.label}有值时渲染`}
              className="rounded bg-green-50 px-2 py-0.5 text-xs text-green-700 hover:bg-green-100"
            >
              {`{if ${field.key}}…{endif}`}
            </button>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        aria-label={`区块 ${index + 1} 内容`}
        value={block.content}
        onChange={(event) => onUpdate(index, { content: event.target.value })}
        placeholder="输入内容，点击上方按钮在光标位置插入变量…"
        rows={block.type === "paragraph" ? 4 : 2}
        className="w-full resize-y rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-mono focus:border-blue-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
      />
      <p className="mt-1 text-xs text-gray-400">
        {block.type === "heading" && "将编译为 <h2> 标题"}
        {block.type === "paragraph" && "将编译为 <p> 段落，支持多行文本和变量"}
        {block.type === "cta" && "将编译为指向正式阅读地址的按钮文本"}
      </p>
    </div>
  );
}
