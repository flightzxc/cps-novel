import { SectionHeader } from "@/components/SectionHeader";
import type { PreviewChapterRef } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";

/** 可试读章节区块的锚点。详情页内唯一，不新建独立目录路由。 */
export const PREVIEW_CHAPTERS_ANCHOR = "preview-chapters";

/**
 * 可试读章节区块 —— 嵌在详情页内（D-12 已由 Owner 定案：不建独立目录路由）。
 *
 * 四条硬约束，全部体现在这个组件里：
 *
 *   1. 🔴 **只列上游实际返回的章节。** 组件只渲染传入的数组，没有任何按总章数
 *      补齐的逻辑，也不接受总章数作为入参——从签名上就做不到伪造。
 *   2. 🔴 **不宣称完整。** 标题是「可试读章节」，说明文字写的是本站可试读多少章。
 *      不得出现「完整目录」「全部章节」这类表述。
 *   3. 🔴 **这不是目录，是样章。** 每条带章号与章名、可点进阅读，按样章的节奏排，
 *      不按目录的节奏排。
 *   4. 🔴 **没有章节就整块不渲染**（Owner 决策 2026-09-18，发布与 Preview 解耦）。
 *      解耦之后，没有试读的文章可以正常发布，于是"零章节"从一个不该出现的
 *      异常态，变成了一个**正常且长期存在**的页面形态。此前这里会渲染一个
 *      「可试读章节」标题加一张写着 `novel.noPreviewChapters` 的空状态卡片——
 *      那正是把后台的采集缺口当作产品文案讲给读者听。现在直接返回 `null`，
 *      与同页的标签区、内容推荐区（`NovelDetailScreen.tsx`：无数据即整块消失、
 *      不留标题不留空框）取齐。
 *
 *      注意这里判定的是"传进来的数组为空"，而数组来自
 *      `listPreviewChapterRefs`（`src/lib/site/queries.ts`），它本身就带
 *      `content: { isNot: null }` 过滤——所以一个只有章节行、没有正文的
 *      "空壳章节"根本进不了这个数组，不会被渲染成一个点进去没内容的链接。
 */
export function PreviewChapterList({
  locale,
  chapters,
}: {
  locale: SiteLocale;
  chapters: PreviewChapterRef[];
}) {
  const t = getPublicT(locale);
  if (chapters.length === 0) return null;

  return (
    <section
      id={PREVIEW_CHAPTERS_ANCHOR}
      aria-labelledby="preview-chapters-title"
      className="scroll-mt-8 pt-14 md:pt-20"
      data-testid="preview-chapters"
    >
      <SectionHeader
        id="preview-chapters-title"
        title={t("novel.previewChapters")}
        description={
          // 施工工单_I18N_复数能力 §6.2: t() 现在经 intl-messageformat 渲染
          // ICU plural，`novel.previewChaptersDescription` 自己按 count 选
          // 分支（`one`/`other`，语种按各自 CLDR 类别），不再需要在调用点
          // 用 length===1 三元式挑一个单独的 `...One` 键。
          t("novel.previewChaptersDescription", { count: chapters.length })
        }
      />

      <ol className="list-none border-t border-novel-border p-0" data-testid="preview-chapter-list">
        {chapters.map((chapter) => (
          <li key={chapter.number} className="border-b border-novel-border">
            <a
              href={chapter.href}
              className="flex items-baseline gap-4 py-4 transition-colors hover:bg-novel-bg-elevated md:py-5"
            >
              <span className="w-14 shrink-0 text-sm tabular-nums text-novel-fg-subtle md:w-16">
                {t("novel.chapterHeading", { number: chapter.number })}
              </span>
              <span className="font-novel-serif text-base text-novel-fg md:text-lg">
                {chapter.title}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
