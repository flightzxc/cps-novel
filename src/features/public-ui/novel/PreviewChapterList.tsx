import { SectionHeader } from "@/components/SectionHeader";
import type { PreviewChapterRef } from "@/features/public-ui/types";

/** 可试读章节区块的锚点。详情页内唯一，不新建独立目录路由。 */
export const PREVIEW_CHAPTERS_ANCHOR = "preview-chapters";

/**
 * 可试读章节区块 —— 嵌在详情页内（D-12 已由 Owner 定案：不建独立目录路由）。
 *
 * 三条硬约束，全部体现在这个组件里：
 *
 *   1. 🔴 **只列上游实际返回的章节。** 组件只渲染传入的数组，没有任何按总章数
 *      补齐的逻辑，也不接受总章数作为入参——从签名上就做不到伪造。
 *   2. 🔴 **不宣称完整。** 标题是「可试读章节」，说明文字写的是本站可试读多少章。
 *      不得出现「完整目录」「全部章节」这类表述。
 *   3. 🔴 **这不是目录，是样章。** 每条带章号与章名、可点进阅读，按样章的节奏排，
 *      不按目录的节奏排。
 */
export function PreviewChapterList({ chapters }: { chapters: PreviewChapterRef[] }) {
  const hasChapters = chapters.length > 0;

  return (
    <section
      id={PREVIEW_CHAPTERS_ANCHOR}
      aria-labelledby="preview-chapters-title"
      className="scroll-mt-8 pt-14 md:pt-20"
      data-testid="preview-chapters"
    >
      <SectionHeader
        id="preview-chapters-title"
        title="可试读章节"
        description={
          hasChapters
            ? `本站可试读 ${chapters.length} 章，均由上游实际提供。`
            : undefined
        }
      />

      {hasChapters ? (
        <ol className="list-none border-t border-novel-border p-0" data-testid="preview-chapter-list">
          {chapters.map((chapter) => (
            <li key={chapter.number} className="border-b border-novel-border">
              <a
                href={chapter.href}
                className="flex items-baseline gap-4 py-4 transition-colors hover:bg-novel-bg-elevated md:py-5"
              >
                <span className="w-14 shrink-0 text-sm tabular-nums text-novel-fg-subtle md:w-16">
                  第 {chapter.number} 章
                </span>
                <span className="font-novel-serif text-base text-novel-fg md:text-lg">
                  {chapter.title}
                </span>
              </a>
            </li>
          ))}
        </ol>
      ) : (
        <p
          className="rounded-novel-lg border border-novel-border bg-novel-bg-elevated px-6 py-10 text-center text-sm text-novel-fg-muted"
          data-testid="preview-chapters-empty"
        >
          这本书目前没有可以试读的章节。
        </p>
      )}
    </section>
  );
}
