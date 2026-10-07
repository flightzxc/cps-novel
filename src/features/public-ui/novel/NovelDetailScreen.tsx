import { ButtonLink } from "@/components/Button";
import { Container } from "@/components/Container";
import { CoverImage } from "@/components/CoverImage";
import { MetaList } from "@/components/MetaList";
import { SectionHeader } from "@/components/SectionHeader";
import { TagList } from "@/components/Tag";
import { BookGrid } from "@/features/public-ui/book/BookGrid";
import { SiteShell, type SiteChrome } from "@/features/public-ui/layout/SiteShell";
import { StickyCTA } from "@/features/public-ui/layout/StickyCTA";
import type { NovelCardView, NovelDetailView } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { PREVIEW_CHAPTERS_ANCHOR, PreviewChapterList } from "./PreviewChapterList";

/**
 * 小说详情页。
 *
 * 结构（D-12 定案：可试读章节嵌入本页，不建独立目录路由）：
 *   页头 → 主要书籍信息区 → 行动区 → 简介 → 可试读章节区块 → 可选推荐 → 页脚
 *
 * 这一页的设计难点是**版面很空**：真实字段只有封面、书名、简介、语种、总章数、
 * 约三条可试读章节，标签还可能整块不存在。
 *
 * 解决手段只有三种，且**禁止**用虚构元数据补密度：
 *   一、排版——书名用衬线体、接近显示级字号、独占一行，自己撑起半个首屏；
 *   二、简介——当作正文对待，给阅读级的字号、行高与行长，而不是塞在角落的说明文字；
 *   三、可试读章节区块 + 留白——它是页面的第二个重心，承担下半部分。
 *
 * 两个行动的主次：站内试读是主（免费、在站内、是这一页承诺的东西），
 * 正式阅读是强次级。到最后一章读完时主次会反转，见章节页。
 */
export function NovelDetailScreen({
  locale,
  novel,
  chrome,
  related,
  relatedTitle,
  newReleases,
}: {
  locale: SiteLocale;
  novel: NovelDetailView;
  chrome?: SiteChrome;
  /** "相关推荐"（A4/B3）：候选不足时正常显示已有的几本；一本都没有时整块不渲染，不留空框。 */
  related?: NovelCardView[];
  relatedTitle?: string;
  /** "新书推荐"（A4/B3）：同语种已发布小说页按 publishedAt 倒序，排除当前书与已出现在 related 里的书。 */
  newReleases?: NovelCardView[];
}) {
  const t = getPublicT(locale);
  const firstPreviewChapter = novel.previewChapters[0];
  const hasPreview = novel.previewChapters.length > 0;

  return (
    <SiteShell locale={locale} chrome={chrome}>
      <Container>
        {/* --- 主要书籍信息区 --- */}
        <article className="pt-10 md:pt-16">
          <div className="grid gap-8 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)] md:gap-12">
            <div className="mx-auto w-full max-w-[200px] md:mx-0 md:max-w-none">
              <CoverImage
                src={novel.coverUrl}
                alt={t("novel.coverAlt", { title: novel.title })}
                sizeHint="(min-width: 768px) 260px, 200px"
                // 主封面在首屏一定可见：eager + 高优先级（B-37 阶段 0；CPS 详情主封面同款）
                priority
              />
            </div>

            <div className="flex flex-col items-start">
              <h1 className="font-novel-serif text-3xl leading-[1.15] font-semibold tracking-tight text-balance text-novel-fg md:text-[2.75rem]">
                {novel.title}
              </h1>

              {/* 元信息：流式，只渲染真实存在的字段，一项也没有时整行不渲染 */}
              <MetaList
                className="mt-4"
                items={[
                  { key: "chapters", value: t("novel.chapterCount", { count: novel.totalChapterCount }) },
                  hasPreview && {
                    key: "preview",
                    value: t("novel.previewCount", { count: novel.previewChapters.length }),
                  },
                ]}
              />

              {/* 标签为空 → 整块消失，不留标题、不留空框 */}
              <TagList tags={novel.tags} className="mt-5" label={t("novel.genreTags")} />

              {/* --- 行动区 --- */}
              <div className="mt-8 flex flex-wrap gap-3 md:mt-10">
                {hasPreview ? (
                  <ButtonLink
                    href={firstPreviewChapter?.href ?? `#${PREVIEW_CHAPTERS_ANCHOR}`}
                    variant="accent"
                    size="lg"
                  >
                    {t("novel.startPreview")}
                  </ButtonLink>
                ) : null}

                {/* 正式阅读入口只在拿到公开跳转码时渲染；渠道真实码绝不进页面 */}
                {novel.readOnUpstreamHref ? (
                  <ButtonLink
                    href={novel.readOnUpstreamHref}
                    variant="outline"
                    size="lg"
                    rel="nofollow sponsored"
                  >
                    {t("novel.readOnUpstream")}
                  </ButtonLink>
                ) : null}
              </div>
            </div>
          </div>

          {/* --- 简介：当作正文对待 --- */}
          <section aria-labelledby="synopsis" className="pt-14 md:pt-20">
            <SectionHeader id="synopsis" title={t("novel.synopsis")} />
            <div className="max-w-[68ch] font-novel-serif text-[1.0625rem] leading-[1.8] text-novel-fg-muted md:text-lg">
              {novel.description
                .split("\n")
                .map((paragraph) => paragraph.trim())
                .filter(Boolean)
                .map((paragraph, index) => (
                  <p key={index} className="mt-5 first:mt-0">
                    {paragraph}
                  </p>
                ))}
            </div>
          </section>

          {/* --- 章节列表区块（嵌入本页） --- */}
          <PreviewChapterList
            locale={locale}
            chapters={novel.previewChapters}
            totalChapterCount={novel.totalChapterCount}
            readOnUpstreamHref={novel.readOnUpstreamHref}
          />
        </article>

        {/* --- 相关推荐（A4/B3）：无数据即整块不渲染，不留空框 --- */}
        {related && related.length > 0 ? (
          <section aria-labelledby="related-works" className="pt-14 md:pt-20">
            <SectionHeader id="related-works" title={relatedTitle ?? t("novel.relatedWorks")} />
            <BookGrid locale={locale} novels={related} minimal />
          </section>
        ) : null}

        {/* --- 新书推荐（A4/B3）：无数据即整块不渲染，不留空框 --- */}
        {newReleases && newReleases.length > 0 ? (
          <section aria-labelledby="new-releases" className="pt-14 md:pt-20 pb-14 md:pb-20">
            <SectionHeader id="new-releases" title={t("novel.newReleases")} />
            <BookGrid locale={locale} novels={newReleases} minimal />
          </section>
        ) : null}
      </Container>

      {/* --- 固定底部浮窗（B1）：没有公开跳转码时不渲染 --- */}
      <StickyCTA locale={locale} href={novel.readOnUpstreamHref} />
    </SiteShell>
  );
}
