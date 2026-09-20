import type { NovelCardView } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { BookCard } from "./BookCard";

/**
 * 卡片网格。
 *
 * 密度是刻意降档的：移动 2 列、桌面 5 列。
 * 参考的四个竞品普遍是移动 3 列、桌面 6 列——各减一到两列，对应
 * 「阅读类产品比视频类更松」这条方向定调。槽宽也相应加大。
 *
 * 🔴 列数是 Owner 口径。默认档（聚合页 / 题材页）维持窄屏 2 列，**不要跟着
 * 首页一起改**。
 *
 * `variant="home"` 的窄屏列数 2026-09-20 由 Owner 拍板改为 3：首页那一屏要
 * 跟主推 banner 分像素，而「390×844 露 1.8 排」这条验收在 2 列下算不出来——
 * 封面本身就 223px 高，即便书名与行距全部归零、网格顶到理论极限 437，
 * (844-437)/223 也只有 1.83，那已经不是一张能用的卡片。换 3 列后封面收到
 * 141px，同一个网格顶位置就能露到 1.86 排，不必再去压 banner。
 *
 * 🔴 3 列有下限：**窄于 360px 退回 2 列**。320 宽下 3 列的槽位只有 85px，
 * 封面缩成缩略图、书名两行基本只剩首词。360 是这套 20px 容器内边距 +
 * 16px 列间距下 3 列仍然成立的最窄点（槽位 96px）。
 * 断点写成 `min-[360px]:` 而不是借用 `sm`(640)：360–639 这一段正是主力机型
 * （390 / 393 / 412 / 430 全在里面），借 `sm` 等于整段拿不到 3 列。
 *
 * 除列数外，`variant="home"` 还动**行距**（窄屏 32 → 20）和**卡片在窄屏的
 * 信息量**（`compactOnMobile`）。聚合页 / 题材页三者都不受影响。
 */
export function BookGrid({
  locale,
  novels,
  emptyMessage,
  variant = "default",
}: {
  locale: SiteLocale;
  novels: NovelCardView[];
  emptyMessage?: string;
  variant?: "default" | "home";
}) {
  const isHome = variant === "home";
  const message = emptyMessage ?? getPublicT(locale)("collection.empty");
  if (novels.length === 0) {
    return (
      <p
        className="rounded-novel-lg border border-novel-border bg-novel-bg-elevated px-6 py-12 text-center text-sm text-novel-fg-muted"
        data-testid="book-grid-empty"
      >
        {message}
      </p>
    );
  }

  return (
    <ul
      className={
        "grid list-none gap-x-4 p-0 md:gap-x-7 md:gap-y-10 lg:grid-cols-5 " +
        // 窄屏列数：首页 ≥360 起 3 列（<360 退回 2 列），其余一律 2 列到 sm。
        (isHome ? "grid-cols-2 min-[360px]:grid-cols-3 " : "grid-cols-2 sm:grid-cols-3 ") +
        // 桌面行距两档一致（md:gap-y-10），只有窄屏分档：首页 20px，其余 32px。
        (isHome ? "gap-y-5" : "gap-y-8")
      }
      data-testid="book-grid"
      data-grid-variant={variant}
    >
      {novels.map((novel) => (
        <li key={novel.id}>
          <BookCard locale={locale} novel={novel} compactOnMobile={isHome} />
        </li>
      ))}
    </ul>
  );
}
