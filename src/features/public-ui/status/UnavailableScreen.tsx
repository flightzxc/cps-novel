import { ButtonLink } from "@/components/Button";
import { Container } from "@/components/Container";
import { SiteShell, type SiteChrome } from "@/features/public-ui/layout/SiteShell";
import type { UnavailableReason } from "@/features/public-ui/types";

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
const COPY: Record<UnavailableReason, { title: string; body: string }> = {
  unpublished: {
    title: "这本书暂时不可阅读",
    body: "它已从本站下架。如果之后重新上架，这个地址仍然有效。",
  },
  takedown: {
    title: "这本书已经撤回",
    body: "应内容方要求，本站不再提供这本书的页面。这是一次永久性的撤回。",
  },
};

export function UnavailableScreen({
  reason,
  homeHref = "/",
  chrome,
  /** 可选：把书名说出来，让用户确认自己没走错地方。没有就不显示。 */
  novelTitle,
}: {
  reason: UnavailableReason;
  homeHref?: string;
  chrome?: SiteChrome;
  novelTitle?: string;
}) {
  const copy = COPY[reason];

  return (
    <SiteShell chrome={chrome}>
      <Container>
        <div
          className="flex min-h-[46vh] flex-col items-start justify-center py-20 md:py-28"
          data-testid="unavailable-screen"
          data-unavailable-reason={reason}
        >
          <div className="max-w-[52ch]">
            {novelTitle ? (
              <p className="font-novel-serif text-base text-novel-fg-subtle">
                《{novelTitle}》
              </p>
            ) : null}

            <h1 className="mt-3 font-novel-serif text-2xl leading-tight font-semibold tracking-tight text-novel-fg md:text-4xl">
              {copy.title}
            </h1>

            <p className="mt-5 text-base leading-relaxed text-novel-fg-muted">{copy.body}</p>

            <ButtonLink href={homeHref} variant="outline" size="lg" className="mt-10">
              回到首页
            </ButtonLink>
          </div>
        </div>
      </Container>
    </SiteShell>
  );
}
