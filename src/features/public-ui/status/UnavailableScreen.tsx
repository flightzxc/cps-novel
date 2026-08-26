import { SiteShell, type SiteChrome } from "@/features/public-ui/layout/SiteShell";
import { PublicStatusPanel } from "@/features/public-ui/status/PublicStatusPanel";
import type { UnavailableReason } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT, type MessageKey } from "@/lib/locale/messages";

/**
 * 下架 / 撤回状态页。
 *
 * 语气要求：**稳定、克制、不制造错误感**。
 * 不用红色大叉、不用「出错了」这类措辞——这不是故障，是一次正常的内容状态变更。
 * 用平静的陈述句说明当前不可阅读，并给一条回到首页的路。
 *
 * 两种状态文案不同、视觉相同。实际的 HTTP 状态码（下架 404 / 撤回 410）由内容
 * 阶段的路由层负责，本轮只做页面形态。
 */
const COPY_KEYS: Record<UnavailableReason, { title: MessageKey; body: MessageKey }> = {
  unpublished: {
    title: "unavailable.unpublishedTitle",
    body: "unavailable.unpublishedBody",
  },
  takedown: {
    title: "unavailable.takedownTitle",
    body: "unavailable.takedownBody",
  },
};

export function UnavailableScreen({
  locale,
  reason,
  homeHref = "/",
  chrome,
  /** 可选：把书名说出来，让用户确认自己没走错地方。没有就不显示。 */
  novelTitle,
}: {
  locale: SiteLocale;
  reason: UnavailableReason;
  homeHref?: string;
  chrome?: SiteChrome;
  novelTitle?: string;
}) {
  const t = getPublicT(locale);
  const copy = COPY_KEYS[reason];

  return (
    <SiteShell locale={locale} chrome={chrome}>
      <PublicStatusPanel
        testId="unavailable-screen"
        reason={reason}
        eyebrow={novelTitle}
        title={t(copy.title)}
        body={t(copy.body)}
        homeHref={homeHref}
        homeLabel={t("unavailable.returnHome")}
      />
    </SiteShell>
  );
}
