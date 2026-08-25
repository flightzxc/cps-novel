import { ButtonLink } from "@/components/Button";
import { Container } from "@/components/Container";
import { SiteShell, type SiteChrome } from "@/features/public-ui/layout/SiteShell";
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
      <Container>
        <div
          className="flex min-h-[46vh] flex-col items-start justify-center py-20 md:py-28"
          data-testid="unavailable-screen"
          data-unavailable-reason={reason}
        >
          <div className="max-w-[52ch]">
            {novelTitle ? (
              <p className="font-novel-serif text-base text-novel-fg-subtle">
                {novelTitle}
              </p>
            ) : null}

            <h1 className="mt-3 font-novel-serif text-2xl leading-tight font-semibold tracking-tight text-novel-fg md:text-4xl">
              {t(copy.title)}
            </h1>

            <p className="mt-5 text-base leading-relaxed text-novel-fg-muted">{t(copy.body)}</p>

            <ButtonLink href={homeHref} variant="outline" size="lg" className="mt-10">
              {t("unavailable.returnHome")}
            </ButtonLink>
          </div>
        </div>
      </Container>
    </SiteShell>
  );
}
