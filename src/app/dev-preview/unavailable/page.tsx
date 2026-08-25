import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/** MOCK_ONLY 预览：下架状态 */
export default function UnavailablePreviewPage() {
  return (
    <UnavailableScreen
      locale={PUBLIC_SITE_LOCALE}
      chrome={mockChrome(PUBLIC_SITE_LOCALE)}
      reason="unpublished"
      novelTitle="The Lantern Keeper's Daughter"
      homeHref="/dev-preview/home"
    />
  );
}
