import { NovelNotFoundBody, notFoundMetadata } from "@/app/_pages/novel-not-found";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const metadata = notFoundMetadata;

/**
 * Shared 404 shell for this novel segment (missing slug, unknown short id,
 * takedown/withdrawn). V1 maps rights-removal to `notFound()` so Next emits
 * a real HTTP 404; HTTP 410 is post-V1 (proxy layer).
 *
 * 2026-09-30：现在渲染真正的 404 页（带站名的页头页脚），不再是"暂时不可用"
 * 的下架文案——见 `@/app/_pages/novel-not-found`。
 */
export default async function NovelNotFoundPage() {
  return NovelNotFoundBody({ locale: PUBLIC_SITE_LOCALE });
}
