import { Container } from "@/components/Container";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import { SiteShell } from "@/features/public-ui/layout/SiteShell";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE, asSiteLocale } from "@/lib/site/locale-label";
import { localePrefix } from "@/lib/slug/article-path";

/**
 * MOCK_ONLY 预览：页头（PN-15 第二批，手机端方案 A + 搜索入口）。
 *
 * 查询参数：
 * - `?locale=fr`：页头与菜单文案所属语种（15 语任选，默认 en）。`ar` 可看从右到左镜像；
 * - `?current=search|home|collection`：当前页高亮落在哪一项（默认都不高亮）；
 * - `?overlay=1`：页头浮在一块深色主视觉上（首页 Hero 的透明页头形态）；
 * - `?search=off`：模拟后台开关关闭（不传 `searchHref`，页头里没有任何搜索入口）。
 *
 * 15 个语种全部算「活跃」，语种菜单（桌面胶囊 / 手机菜单里的语种行）列出全部条目。
 * 搜索入口的地址与生产同形（`/search`、`/{语种}/search`），预览里点它会去真实的搜索路由。
 */
export default async function HeaderPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string; current?: string; overlay?: string; search?: string }>;
}) {
  const query = await searchParams;
  const locale = asSiteLocale(query.locale ?? "") ?? PUBLIC_SITE_LOCALE;
  const t = getPublicT(locale);
  const current = query.current;
  const searchOn = query.search !== "off";
  const overlay = query.overlay === "1";

  const chrome = {
    ...mockChrome(locale, current),
    activeLocales: SITE_LOCALES,
    ...(searchOn ? { searchHref: `${localePrefix(locale)}/search`, searchCurrent: current === "search" } : {}),
  };

  return (
    <SiteShell locale={locale} chrome={chrome} headerOverlay={overlay}>
      {overlay ? (
        <div className="h-72 bg-novel-bg-raised" aria-hidden="true" />
      ) : null}
      <Container className="flex flex-col gap-3 py-5">
        <h1 className="font-novel-serif text-xl font-semibold text-novel-fg">{t("nav.browse")}</h1>
        <div className="grid grid-cols-2 gap-3">
          <div className="h-40 rounded-novel-md bg-novel-bg-raised" />
          <div className="h-40 rounded-novel-md bg-novel-bg-raised" />
        </div>
        <div className="h-24 rounded-novel-md bg-novel-bg-raised" />
      </Container>
    </SiteShell>
  );
}
