import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import {
  MOCK_NOVEL_CARDS,
  MOCK_NOVEL_DETAIL,
} from "@/features/public-ui/fixtures/mock-content";

/** MOCK_ONLY 预览：首页页面壳 */
export default function HomePreviewPage() {
  return (
    <HomeScreen
      chrome={mockChrome("home")}
      featured={MOCK_NOVEL_DETAIL}
      featuredDetailHref="/dev-preview/novel"
      featuredStartReadingHref="/dev-preview/chapter"
      novels={MOCK_NOVEL_CARDS}
      browseAllHref="/dev-preview/collection"
    />
  );
}
