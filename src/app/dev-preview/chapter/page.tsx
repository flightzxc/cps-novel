import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import { MOCK_CHAPTER } from "@/features/public-ui/fixtures/mock-content";

/** MOCK_ONLY 预览：章节阅读页（第 1 章，有下一章） */
export default function ChapterPreviewPage() {
  return <ChapterScreen chrome={mockChrome()} chapter={MOCK_CHAPTER} />;
}
