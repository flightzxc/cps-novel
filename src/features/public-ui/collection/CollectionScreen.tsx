import { Container } from "@/components/Container";
import { BookGrid } from "@/features/public-ui/book/BookGrid";
import { SiteShell, type SiteChrome } from "@/features/public-ui/layout/SiteShell";
import type { NovelCardView } from "@/features/public-ui/types";

/**
 * 语言聚合 / 题材聚合的共用屏幕。
 *
 * 两种聚合共用同一个页面形态与**同一个卡片组件**，不做第二套卡片形态——
 * 这既省一半的设计与回归面，也保证用户在不同入口看到的是同一种东西。
 */
export function CollectionScreen({
  title,
  description,
  novels,
  chrome,
  emptyMessage,
}: {
  title: string;
  /** 一句说明这个集合是什么。没有就不渲染。 */
  description?: string;
  novels: NovelCardView[];
  chrome?: SiteChrome;
  emptyMessage?: string;
}) {
  return (
    <SiteShell chrome={chrome}>
      <Container>
        <header className="border-b border-novel-border pt-12 pb-8 md:pt-20 md:pb-10">
          <h1 className="font-novel-serif text-3xl leading-tight font-semibold tracking-tight text-balance text-novel-fg md:text-[2.5rem]">
            {title}
          </h1>
          {description ? (
            <p className="mt-4 max-w-[60ch] text-base text-novel-fg-muted">{description}</p>
          ) : null}
          <p className="mt-4 text-sm text-novel-fg-subtle tabular-nums">
            {novels.length} 部作品
          </p>
        </header>

        <div className="pt-10 md:pt-14">
          <BookGrid novels={novels} emptyMessage={emptyMessage} />
        </div>
      </Container>
    </SiteShell>
  );
}
