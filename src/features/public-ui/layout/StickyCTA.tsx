import { ButtonLink } from "@/components/Button";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";

/**
 * 固定底部浮窗（B1，照搬 CPS v8.5.1 `src/components/site/sticky-cta.tsx` 的
 * 结构，去掉海阅没有的推广码复制与埋点——海阅只有一个动作：跳
 * `readOnUpstreamHref`）。
 *
 * 用在小说页与章节页（章节页必做，小说页与 CPS 一致）。没有公开跳转码时
 * 整块不渲染——与页面里其它"正式阅读"入口同一条规则：渠道真实码绝不进
 * 页面，缺码就不渲染任何跳转 UI。
 *
 * 🔴 渲染两个部分：一个占位 spacer（普通文档流里的空 div，撑开高度）+ 一个
 * `fixed bottom-0` 的浮窗本体。spacer 必须和浮窗本体高度一致，且必须放在
 * 调用方 `<main>` 内容的最后——这样它才能把页脚往下推开，浮窗才不会盖住
 * 正文最后一段或页脚。不能只渲染浮窗本体：`fixed` 元素脱离文档流，不会自动
 * 让出空间。
 *
 * 纯展示、没有交互状态，不需要 "use client"：`getPublicT(locale)` 不依赖
 * `MessagesProvider`，服务端组件（`NovelDetailScreen`）与客户端组件
 * （`ChapterScreen` 的 `ChapterScreenBody`）都能直接渲染它，standalone 测试
 * 也不需要额外包一层 Provider。
 */
export function StickyCTA({ locale, href }: { locale: SiteLocale; href?: string }) {
  const t = getPublicT(locale);
  if (!href) return null;

  return (
    <>
      <div aria-hidden="true" className="h-20 md:h-24" data-testid="sticky-cta-spacer" />
      <div
        role="region"
        aria-label={t("novel.continueReadingBarLabel")}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-novel-border bg-novel-bg-elevated/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm"
        data-testid="sticky-cta"
      >
        <div className="mx-auto flex max-w-6xl items-center justify-center px-4 py-3 md:justify-start">
          <ButtonLink
            href={href}
            variant="accent"
            size="lg"
            rel="nofollow sponsored"
            className="w-full md:w-auto"
          >
            {t("novel.readOnUpstream")}
          </ButtonLink>
        </div>
      </div>
    </>
  );
}
