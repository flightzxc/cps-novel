import { ButtonLink } from "@/components/Button";
import { Container } from "@/components/Container";
import { CoverImage } from "@/components/CoverImage";
import { MetaList } from "@/components/MetaList";
import { SectionHeader } from "@/components/SectionHeader";
import { TagList } from "@/components/Tag";
import { BookGrid } from "@/features/public-ui/book/BookGrid";
import { SiteShell, type SiteChrome } from "@/features/public-ui/layout/SiteShell";
import type { NovelCardView, NovelDetailView } from "@/features/public-ui/types";
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
  novel,
  chrome,
  related,
  relatedTitle = "相关作品",
}: {
  novel: NovelDetailView;
  chrome?: SiteChrome;
  /** 内容推荐是可选结构：本轮不接推荐数据，无数据即整块不渲染，不留空框。 */
  related?: NovelCardView[];
  relatedTitle?: string;
}) {
  const firstPreviewChapter = novel.previewChapters[0];
  const hasPreview = novel.previewChapters.length > 0;

  return (
    <SiteShell chrome={chrome}>
      <Container>
        {/* --- 主要书籍信息区 --- */}
        <article className="pt-10 md:pt-16">
          <div className="grid gap-8 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)] md:gap-12">
            <div className="mx-auto w-full max-w-[200px] md:mx-0 md:max-w-none">
              <CoverImage
                src={novel.coverUrl}
                alt={`《${novel.title}》封面`}
                sizeHint="(min-width: 768px) 260px, 200px"
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
                  { key: "locale", value: novel.locale.label },
                  { key: "chapters", value: `共 ${novel.totalChapterCount} 章` },
                  hasPreview && {
                    key: "preview",
                    value: `可试读 ${novel.previewChapters.length} 章`,
                  },
                ]}
              />

              {/* 标签为空 → 整块消失，不留标题、不留空框 */}
              <TagList tags={novel.tags} className="mt-5" label="题材标签" />

              {/* --- 行动区 --- */}
              <div className="mt-8 flex flex-wrap gap-3 md:mt-10">
                {hasPreview ? (
                  <ButtonLink
                    href={firstPreviewChapter?.href ?? `#${PREVIEW_CHAPTERS_ANCHOR}`}
                    variant="accent"
                    size="lg"
                  >
                    开始试读
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
                    前往正式阅读
                  </ButtonLink>
                ) : null}
              </div>
            </div>
          </div>

          {/* --- 简介：当作正文对待 --- */}
          <section aria-labelledby="synopsis" className="pt-14 md:pt-20">
            <SectionHeader id="synopsis" title="简介" />
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

          {/* --- 可试读章节区块（嵌入本页） --- */}
          <PreviewChapterList chapters={novel.previewChapters} />
        </article>

        {/* --- 可选的内容推荐结构：无数据即整块不渲染 --- */}
        {related && related.length > 0 ? (
          <section aria-labelledby="related-works" className="pt-14 md:pt-20">
            <SectionHeader id="related-works" title={relatedTitle} />
            <BookGrid novels={related} />
          </section>
        ) : null}
      </Container>
    </SiteShell>
  );
}
