import { SiteShell, type SiteChrome } from "@/features/public-ui/layout/SiteShell";
import { PublicStatusPanel } from "@/features/public-ui/status/PublicStatusPanel";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";

/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
 * blog's own "stable noindex removal" screen (`access.ts`'s
 * `BlogArticleAccessResult`'s `unavailable` kind — a blog Article marked
 * `unpublished`). Deliberately NOT `features/public-ui/status/
 * UnavailableScreen` — that component's copy (`unavailable.unpublishedTitle`/
 * `Body` in `src/lib/locale/messages/en.ts`) is hardcoded "This **book** is
 * temporarily unavailable" / "...no longer offers this **book**", which
 * would misdescribe a blog post. Same `PublicStatusPanel` building block
 * `UnavailableScreen` itself wraps, own blog-worded copy instead. `takedown`
 * has no screen of its own here, matching this round's other public route
 * (`/novel/[slugParam]/page.tsx` routes `takedown` to `notFound()`, not to
 * `UnavailableScreen`'s own `reason="takedown"` branch — see that file; a
 * blog Article follows the same precedent for consistency, not a new
 * decision this round makes).
 */
export function BlogUnavailableScreen({
  locale,
  postTitle,
  homeHref = "/",
  chrome,
}: {
  locale: SiteLocale;
  postTitle: string;
  homeHref?: string;
  chrome?: SiteChrome;
}) {
  const t = getPublicT(locale);

  return (
    <SiteShell locale={locale} chrome={chrome}>
      <PublicStatusPanel
        testId="blog-unavailable-screen"
        reason="unpublished"
        eyebrow={postTitle}
        title={t("blog.unpublishedTitle")}
        body={t("blog.unpublishedBody")}
        homeHref={homeHref}
        homeLabel={t("unavailable.returnHome")}
      />
    </SiteShell>
  );
}
