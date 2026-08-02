import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";

/**
 * MOCK_ONLY 预览：撤回状态。
 * 与下架文案不同、视觉相同。实际的 HTTP 状态码由内容阶段的路由层负责。
 */
export default function TakedownPreviewPage() {
  return (
    <UnavailableScreen
      chrome={mockChrome()}
      reason="takedown"
      novelTitle="Nine Winters in the Glass House"
      homeHref="/dev-preview/home"
    />
  );
}
