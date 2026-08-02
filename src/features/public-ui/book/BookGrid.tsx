import type { NovelCardView } from "@/features/public-ui/types";
import { BookCard } from "./BookCard";

/**
 * 卡片网格。
 *
 * 密度是刻意降档的：移动 2 列、桌面 5 列。
 * 参考的四个竞品普遍是移动 3 列、桌面 6 列——各减一到两列，对应
 * 「阅读类产品比视频类更松」这条方向定调。槽宽也相应加大。
 */
export function BookGrid({
  novels,
  emptyMessage = "这里暂时没有可以阅读的作品。",
}: {
  novels: NovelCardView[];
  emptyMessage?: string;
}) {
  if (novels.length === 0) {
    return (
      <p
        className="rounded-novel-lg border border-novel-border bg-novel-bg-elevated px-6 py-12 text-center text-sm text-novel-fg-muted"
        data-testid="book-grid-empty"
      >
        {emptyMessage}
      </p>
    );
  }

  return (
    <ul
      className="grid list-none grid-cols-2 gap-x-4 gap-y-8 p-0 sm:grid-cols-3 md:gap-x-7 md:gap-y-10 lg:grid-cols-5"
      data-testid="book-grid"
    >
      {novels.map((novel) => (
        <li key={novel.id}>
          <BookCard novel={novel} />
        </li>
      ))}
    </ul>
  );
}
