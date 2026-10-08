import type { ReactNode } from "react";

import { Container } from "@/components/Container";
import { BookGrid } from "@/features/public-ui/book/BookGrid";
import { SiteShell, type SiteChrome } from "@/features/public-ui/layout/SiteShell";
import type { NovelCardView } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";

/**
 * 语言聚合 / 题材聚合的共用屏幕。
 *
 * 两种聚合共用同一个页面形态与**同一个卡片组件**，不做第二套卡片形态——
 * 这既省一半的设计与回归面，也保证用户在不同入口看到的是同一种东西。
 *
 * PN-06（2026-10-08）：分页条走 `pagination` 插槽，渲染在作品网格之后、页脚之前
 * （`SiteShell` 的 `<main>` 之内）。此前调用方把 `<Pagination/>` 写在整个页面壳**之外**，
 * DOM 顺序成了"网格 → 页脚 → 分页"，读者要滚过页脚才看得到下一页，键盘 Tab 也是先过页脚。
 * 插槽由调用方传入（页码、基础路径、查询参数都属于路由层），本组件不认识分页参数。
 *
 * 标题下的作品数（运营 2026-10-08 反馈"第 2 页显示 20 works、最后一页显示 9 works"，Owner 拍板）：
 * 口径 = 这个列表**分页能翻到的总本数**（`totalCount`），不是当前页的本数（`novels.length`），
 * 也不是"分类在全部书目里的真实总数"。来源必须是 `paginateCards(...).totalCount`——和分页、
 * 站点地图（`listPublicCategoryPageCounts`）、页面 404 判定用的是同一份列表，不得在调用方另写一份
 * 计数；以后列表来源改成全量分页（B-38 根治）时，这个数会自动跟着变成真实总数。
 * 因此 `totalCount` 是**必填**、不给默认值：省略就编译失败，免得哪天又悄悄退回当前页本数。
 */
export function CollectionScreen({
  locale,
  title,
  description,
  novels,
  chrome,
  totalCount,
  emptyMessage,
  pagination,
}: {
  locale: SiteLocale;
  title: string;
  /** 一句说明这个集合是什么。没有就不渲染。 */
  description?: string;
  /** 当前页要渲染的卡片（分页切片）。只用来画网格，**不**用来算标题下的作品数。 */
  novels: NovelCardView[];
  /** 分页覆盖的总本数（`paginateCards(...).totalCount`），每一页显示同一个数；必填，见文件头注释。 */
  totalCount: number;
  chrome?: SiteChrome;
  emptyMessage?: string;
  /** 分页条（通常是 `<Pagination/>`，单页时它自己渲染为 null）。放在网格之后、页脚之前。 */
  pagination?: ReactNode;
}) {
  const t = getPublicT(locale);
  return (
    <SiteShell locale={locale} chrome={chrome}>
      <Container>
        <header className="border-b border-novel-border pt-12 pb-8 md:pt-20 md:pb-10">
          <h1 className="font-novel-serif text-3xl leading-tight font-semibold tracking-tight text-balance text-novel-fg md:text-[2.5rem]">
            {title}
          </h1>
          {description ? (
            <p className="mt-4 max-w-[60ch] text-base text-novel-fg-muted">{description}</p>
          ) : null}
          <p className="mt-4 text-sm text-novel-fg-subtle tabular-nums">
            {t("collection.workCount", { count: totalCount })}
          </p>
        </header>

        <div className="pt-10 md:pt-14">
          <BookGrid locale={locale} novels={novels} emptyMessage={emptyMessage} />
        </div>

        {pagination}
      </Container>
    </SiteShell>
  );
}
