import { CoverImage } from "@/components/CoverImage";
import type { ChapterNovelRef, PreviewPosition } from "@/features/public-ui/types";

/**
 * 轻量书籍归属条。
 *
 * 让每个章节页自证归属：这一章属于哪本书、当前处在试读的什么位置。
 * 这对 self-canonical 的章节页是有价值的结构。
 *
 * 参考站在每个章节页压了一整个书籍头（封面 + 书名 + 一堆元信息），
 * 对阅读体验是打断——我们只做一条细窄条，借鉴意图，不继承重量。
 *
 * 🔴 试读范围的分母是**实际可试读章数**，不是总章数。
 * 全书进度百分比是禁止展示的。
 */
export function BookAttributionBar({
  novel,
  previewPosition,
}: {
  novel: ChapterNovelRef;
  previewPosition: PreviewPosition;
}) {
  return (
    <div
      className="flex items-center gap-3 border-b border-novel-border py-3"
      data-testid="book-attribution-bar"
    >
      <a href={novel.href} className="flex shrink-0 items-center gap-3 rounded-novel-sm">
        <CoverImage
          src={novel.coverUrl}
          alt=""
          className="w-8 shrink-0"
          sizeHint="32px"
        />
        <span className="font-novel-serif text-sm text-novel-fg transition-colors hover:text-novel-primary">
          {novel.title}
        </span>
      </a>

      <span aria-hidden="true" className="text-novel-border-strong">
        ·
      </span>

      <span className="text-sm text-novel-fg-subtle tabular-nums">
        试读 {previewPosition.index} / {previewPosition.total}
      </span>
    </div>
  );
}
