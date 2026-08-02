import { CoverImage } from "@/components/CoverImage";
import { TagList } from "@/components/Tag";
import type { NovelCardView } from "@/features/public-ui/types";

/**
 * 书籍卡片。首页与语言/题材聚合页**共用这一种卡片，不做第二套形态**。
 *
 * 卡片上只有三样东西：封面、书名、（可能为空的）标签。
 * 刻意没有作者、评分、阅读量、集数——这些字段分销接口不提供，不留位置。
 *
 * 密度上刻意比短剧站松一档：书名给到可读字号而不是缩略图标签字号，
 * 因为它是一本书的名字，不是一个视频的文件名。
 */
export function BookCard({ novel }: { novel: NovelCardView }) {
  return (
    <article className="group" data-testid="book-card">
      <a
        href={novel.href}
        className="block rounded-novel-md focus-visible:outline-offset-4"
      >
        <CoverImage
          src={novel.coverUrl}
          alt={`《${novel.title}》封面`}
          className="transition-opacity group-hover:opacity-90"
          sizeHint="(min-width: 768px) 220px, 45vw"
        />
        <h3 className="mt-3 font-novel-serif text-base leading-snug font-medium text-novel-fg">
          {novel.title}
        </h3>
      </a>

      {novel.locale ? (
        <p className="mt-1 text-xs text-novel-fg-subtle">{novel.locale.label}</p>
      ) : null}

      {/* 标签为空时 TagList 返回 null，整块消失，不留空位 */}
      <TagList tags={novel.tags} className="mt-2" label={`《${novel.title}》标签`} />
    </article>
  );
}
