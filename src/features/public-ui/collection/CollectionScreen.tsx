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
 */
export function CollectionScreen({
  locale,
  title,
  description,
  novels,
  chrome,
  emptyMessage,
  pagination,
}: {
  locale: SiteLocale;
  title: string;
  /** 一句说明这个集合是什么。没有就不渲染。 */
  description?: string;
  novels: NovelCardView[];
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
            {t("collection.workCount", { count: novels.length })}
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
