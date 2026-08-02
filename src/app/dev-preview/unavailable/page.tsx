import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";

/** MOCK_ONLY 预览：下架状态 */
export default function UnavailablePreviewPage() {
  return (
    <UnavailableScreen
      chrome={mockChrome()}
      reason="unpublished"
      novelTitle="The Lantern Keeper's Daughter"
      homeHref="/dev-preview/home"
    />
  );
}
