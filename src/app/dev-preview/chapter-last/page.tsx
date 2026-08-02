import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import { MOCK_CHAPTER_LAST } from "@/features/public-ui/fixtures/mock-content";

/**
 * MOCK_ONLY 预览：最后一章试读。
 * 没有下一章，章末的正式阅读入口升为主动作——这是全站唯一一处 CTA 主次反转。
 */
export default function LastChapterPreviewPage() {
  return <ChapterScreen chrome={mockChrome()} chapter={MOCK_CHAPTER_LAST} />;
}
