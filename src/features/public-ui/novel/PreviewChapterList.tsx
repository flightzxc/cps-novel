import { SectionHeader } from "@/components/SectionHeader";
import type { PreviewChapterRef } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { ChapterListBody } from "./ChapterListBody";

/** 章节列表区块的锚点。详情页/章节页内唯一，不新建独立目录路由。 */
export const PREVIEW_CHAPTERS_ANCHOR = "preview-chapters";

/**
 * 章节列表区块 —— 嵌在详情页与章节页内（D-12 已由 Owner 定案：不建独立目录路由）。
 *
 * 🔴 **2026-09-29 Owner 修订 D-12 第 2 条**（见
 * `docs/adr/ADR-D12-chapter-list-lock-revision.md`）：原第 2 条「不宣称完整」
 * 改为下面这套折中规则。**第 1 条「不伪造章节内容」维持原样、不可协商**——
 * 改动只涉及"如何呈现读者拿不到的那部分"，不涉及"伪造那部分的内容"。
 *
 * 修订后的规则，全部体现在本文件 + `ChapterListBody.tsx` + `ContinueReadingModal.tsx`：
 *
 *   1. 🔴 **只列上游实际返回的章节为可点击链接。** 真实章节数组（`chapters`）
 *      不受任何加工——组件不会把它拉伸、也不会假造标题。
 *   2. **总章数 > 真实章节数，且这本书有 `readOnUpstreamHref` 时**，从下一个
 *      编号起追加"锁定章节"条目：只显示"第 N 章"加锁图标，**不编造章名**；
 *      每一条是 `<button>`，**不是 `<a>`，不生成任何网址**。点击后弹出
 *      `ContinueReadingModal`，弹窗里的按钮才跳 `readOnUpstreamHref`。
 *   3. 标题固定为"章节列表"（`novel.chapterListTitle`），并在标题下方用一行
 *      说明显示"共 N 章"（`novel.chapterListCount`，N = `totalChapterCount`，
 *      不是真实章节数）。**不得**出现"完整目录""全部章节"这类措辞——`N` 只是
 *      客观标量的复述（详情页别处的元信息也展示它），不是对这个列表本身的
 *      完整性声明。
 *   4. 🔴 **服务端 HTML 最多渲染 30 条锁定条目**（`ChapterListBody` 的
 *      `SERVER_LOCKED_CAP`）。超过 30 条时展示"展开全部 N 章"按钮，点击后
 *      由客户端在浏览器里就地生成剩余编号——不发请求，不新增路由，不把
 *      几千条数字写进首屏 HTML。
 *   5. 列表之后加一个"阅读更多章节"按钮，同样跳 `readOnUpstreamHref`。
 *   6. **没有 `readOnUpstreamHref` 的书**：不追加锁定条目，也不渲染"展开全部"
 *      与"阅读更多章节"这两个按钮——只有真实章节链接照常列出。
 *   7. 🔴 **不新增路由；JSON-LD 里不为锁定章节生成任何条目。** 锁定章节只是
 *      页面上的视觉占位 + 弹窗，从不出现在任何结构化数据或站点地图里。
 *
 * 🔴 **没有章节就整块不渲染**（Owner 决策 2026-09-18，发布与 Preview 解耦，
 * 本次修订未触碰这一条）。发布与 Preview 解耦之后，没有试读的文章可以正常
 * 发布，"零章节"是一个正常且长期存在的页面形态——不渲染标题、不渲染空状态
 * 卡片，与同页的标签区、推荐区取齐。
 *
 * 传入的 `chapters` 数组来自 `listPreviewChapterRefs`（`src/lib/site/queries.ts`），
 * 它本身就带 `content: { isNot: null }` 过滤——一个只有章节行、没有正文的
 * "空壳章节"根本进不了这个数组，不会被渲染成一个点进去没内容的链接。
 */
export function PreviewChapterList({
  locale,
  chapters,
  totalChapterCount,
  readOnUpstreamHref,
}: {
  locale: SiteLocale;
  chapters: PreviewChapterRef[];
  /** 客观标量，来自 `Novel.totalChapterCount`。只用于展示"共 N 章"与派生锁定条目数，绝不用来拉伸真实章节数组。 */
  totalChapterCount: number;
  /** 经我方公开跳转码构造的正式阅读地址。缺失时不追加锁定条目，也不渲染"展开全部"/"阅读更多章节"按钮。 */
  readOnUpstreamHref?: string;
}) {
  const t = getPublicT(locale);
  if (chapters.length === 0) return null;

  // 真实章节按 canonicalChapterNumber 升序传入（`listPreviewChapterRefs` 的
  // orderBy），锁定区间从最大真实编号的下一个开始——不是从 chapters.length+1
  // 开始，避免真实编号本身存在缺口时把两个不同的章节标成同一个号。
  const maxRealNumber = chapters[chapters.length - 1]!.number;
  const lockedCount = Math.max(0, totalChapterCount - maxRealNumber);
  const hasLocked = lockedCount > 0 && Boolean(readOnUpstreamHref);

  return (
    <section
      id={PREVIEW_CHAPTERS_ANCHOR}
      aria-labelledby="preview-chapters-title"
      className="scroll-mt-8 pt-14 md:pt-20"
      data-testid="preview-chapters"
    >
      <SectionHeader
        id="preview-chapters-title"
        title={t("novel.chapterListTitle")}
        description={t("novel.chapterListCount", { count: totalChapterCount })}
      />

      <ChapterListBody
        locale={locale}
        chapters={chapters}
        lockedStartNumber={maxRealNumber + 1}
        lockedCount={hasLocked ? lockedCount : 0}
        totalChapterCount={totalChapterCount}
        readOnUpstreamHref={readOnUpstreamHref}
      />
    </section>
  );
}
