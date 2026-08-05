import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import {
  MOCK_PREVIEW_CHAPTER_TOTAL,
  getMockChapterView,
} from "@/features/public-ui/fixtures/mock-content";

/**
 * MOCK_ONLY 预览：章节阅读页。
 *
 * 章号是动态段，所以每一章各自是一个独立路由——这是"切章不整页刷新"能成立的
 * 前提：客户端路由要有东西可切。上一版把第 1 章和最后一章做成两个各自写死的
 * 静态页，两页之间只能整页跳转。
 *
 * 🔴 仍属 DEV_PREVIEW：noindex/nofollow、不设 canonical、不进 sitemap。
 * 正式章节 URL 的形态（尤其是否含语种段）由 D-8 单独裁决，本轮不碰。
 */

export function generateStaticParams() {
  return Array.from({ length: MOCK_PREVIEW_CHAPTER_TOTAL }, (_, index) => ({
    chapterNumber: String(index + 1),
  }));
}

/**
 * 每章各自的标题。
 *
 * 🔴 **不设 canonical**：这是 DEV_PREVIEW，不是正式章节页。正式页的
 * self-canonical 要等 D-8 裁定语种段之后随正式路由一起落地。
 *
 * 那为什么还要有 generateMetadata：客户端切章时 Next 会重新求值它，标题因此
 * 逐章更新而不是停在第一章——这既是"元数据不会因为不整页刷新而变陈旧"的实证，
 * 也让 App Router 的路由播报能给读屏用户念出新章节名。
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ chapterNumber: string }>;
}): Promise<Metadata> {
  const { chapterNumber } = await params;
  const chapter = getMockChapterView(Number(chapterNumber));

  return {
    title: chapter
      ? `第 ${chapter.number} 章 ${chapter.title} · ${chapter.novel.title}`
      : "章节不存在",
    robots: { index: false, follow: false },
  };
}

export default async function ChapterPreviewPage({
  params,
}: {
  params: Promise<{ chapterNumber: string }>;
}) {
  const { chapterNumber } = await params;

  // 只接受纯十进制正整数：`01`、`1.0`、`1e0`、`ⅰ` 这些都不该解析成第 1 章，
  // 否则同一章会有多个可访问地址。
  if (!/^[1-9]\d*$/.test(chapterNumber)) {
    notFound();
  }

  const chapter = getMockChapterView(Number(chapterNumber));
  if (!chapter) {
    notFound();
  }

  return <ChapterScreen chrome={mockChrome()} chapter={chapter} />;
}
