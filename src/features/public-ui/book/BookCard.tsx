import { CoverImage } from "@/components/CoverImage";
import { TagList } from "@/components/Tag";
import type { NovelCardView } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";

/**
 * 书籍卡片。首页与语言/题材聚合页共用这一个组件。
 *
 * 卡片上只有三样东西：封面、书名、（可能为空的）标签。
 * 刻意没有作者、评分、阅读量、集数——这些字段分销接口不提供，不留位置。
 *
 * 密度上刻意比短剧站松一档：书名给到可读字号而不是缩略图标签字号，
 * 因为它是一本书的名字，不是一个视频的文件名。
 *
 * --- compactOnMobile（2026-09-20 首屏密度轮）--------------------------------
 * 原本这里写着「不做第二套形态」。现在开了一个**只在窄屏生效**的口子：
 * 首页的网格传 `compactOnMobile`，简介 / 语种 / 标签三块在 `md` 以下不显示，
 * 书名收成 2 行。理由是首页那一屏要同时容纳主推 banner，而 390px 下一张完整
 * 卡片要占掉 ~140px 的文字区，直接决定第一排封面露不露得出来。
 *
 * 这不是第二个组件，也不是第二套桌面形态：
 *   - `md` 及以上完全等同于默认档，桌面首页与聚合页逐像素一致；
 *   - 聚合页 / 题材页不传这个参数，窄屏也保持完整卡片。
 * 实现用 `hidden md:block` 而不是条件渲染：这几块要留在 DOM 里，读屏和
 * 爬虫拿到的内容不因视口宽度而缩水。
 *
 * 书名在紧凑档窄屏降到 `text-sm`（md 起恢复 `text-base`）。这是跟着 3 列走
 * 的：390 下槽位只有 106px，16px 的书名一行放不下 7 个字母，两行截断后
 * 基本只剩首词。14px 让两行能读出一个书名来。
 * 同时加 `break-words`：3 列槽位窄，而 `grid-cols-*` 的轨道是
 * `minmax(0,1fr)` —— 不给断词的话，一个长到放不下的单词会横着溢出槽位。
 */
export function BookCard({
  locale,
  novel,
  compactOnMobile = false,
}: {
  locale: SiteLocale;
  novel: NovelCardView;
  compactOnMobile?: boolean;
}) {
  const t = getPublicT(locale);
  const mobileOnlyHidden = compactOnMobile ? "hidden md:block" : "";
  return (
    <article
      className="group"
      data-testid="book-card"
      data-card-compact={compactOnMobile ? "mobile" : undefined}
    >
      <a
        href={novel.href}
        className="block rounded-novel-md focus-visible:outline-offset-4"
      >
        <CoverImage
          src={novel.coverUrl}
          alt={t("novel.coverAlt", { title: novel.title })}
          className="transition-opacity group-hover:opacity-90"
          sizeHint="(min-width: 768px) 220px, 45vw"
        />
        <h3
          className={
            "mt-3 font-novel-serif leading-snug font-medium text-novel-fg " +
            (compactOnMobile
              ? "line-clamp-2 text-sm break-words md:line-clamp-none md:text-base"
              : "text-base")
          }
        >
          {novel.title}
        </h3>
        {novel.summary ? (
          <p className={`mt-2 line-clamp-3 text-sm leading-5 text-novel-fg-muted ${mobileOnlyHidden}`}>
            {novel.summary}
          </p>
        ) : null}
      </a>

      {novel.locale ? (
        <p className={`mt-1 text-xs text-novel-fg-subtle ${mobileOnlyHidden}`}>{novel.locale.label}</p>
      ) : null}

      {/* 标签为空时 TagList 返回 null，整块消失，不留空位。
          包一层 div 承接 `hidden`：TagList 根节点自带 flex 类，同层 display
          工具类的胜负由生成的 CSS 顺序决定，不能直接塞进它的 className。 */}
      <div className={mobileOnlyHidden}>
        <TagList tags={novel.tags} className="mt-2" label={t("novel.tagsLabel")} />
      </div>
    </article>
  );
}
