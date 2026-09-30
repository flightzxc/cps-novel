import type { Metadata } from "next";

import { noIndexMetadata } from "@/app/_lib/seo-metadata";
import { PublicNotFoundStatus } from "@/features/public-ui/status/PublicNotFoundStatus";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

// TKD 对齐 CPS（Owner 2026-09-30，验收表"404 → Not found | 站点名，仍为 noindex"）：根 404 的正文
// 本来就固定英文（`PublicNotFoundStatus`），标题同样取默认语种文案；品牌后缀由根布局的标题模板加。
// 不设 description，不覆盖根布局继承的描述。
export const metadata: Metadata = noIndexMetadata(getPublicT(PUBLIC_SITE_LOCALE)("meta.notFound"));

/**
 * Root 404. No chrome data is available here, so this is the headless shell
 * of UnavailableScreen — same type, no header or footer.
 */
export default function NotFoundPage() {
  return <PublicNotFoundStatus />;
}
