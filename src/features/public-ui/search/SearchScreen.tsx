import Link from "next/link";

import { Container } from "@/components/Container";
import { BookGrid } from "@/features/public-ui/book/BookGrid";
import { Pagination } from "@/features/public-ui/collection/Pagination";
import { SiteShell, type SiteChrome } from "@/features/public-ui/layout/SiteShell";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { SITE_SEARCH_MAX_QUERY_LENGTH, SITE_SEARCH_MIN_QUERY_LENGTH, type SiteSearchResponse } from "@/lib/site-search/types";
import { localePrefix } from "@/lib/slug/article-path";

import { SearchForm } from "./SearchForm";

/**
 * 搜索页屏幕（PN-15）：H1 + 搜索表单 + 状态文案 +（有结果时）作品网格与翻页条。
 *
 * - 状态文案放在 `<p role="status">` 里：没输入 / 太短 / 太长 / 暂不可用 / 有结果（"Results for “x”" + 作品数）/ 没有结果。
 * - 零结果时下一行整句 `search.emptyHint` 做成指向本语种全部作品页（`/browse`）的链接。
 * - 文案里的搜索词只用归一后的 `displayQuery`，经 React 文本节点输出，天然转义；本组件禁止 `dangerouslySetInnerHTML`。
 * - 作品网格、卡片、翻页条复用"全部作品"页的同一批组件（首页与聚合页共用同一种卡片，不做第二套形态）；
 *   翻页链接 `prefetch={false}`：否则每显示一页结果，浏览器会在后台顺带请求下一页，多跑一次查询。
 */
export function SearchScreen({
  locale,
  chrome,
  result,
}: {
  locale: SiteLocale;
  chrome?: SiteChrome;
  result: SiteSearchResponse;
}) {
  const t = getPublicT(locale);
  const query = result.displayQuery;
  const hasResults = result.status === "ok" && result.items.length > 0;
  const isEmpty = result.status === "ok" && result.items.length === 0;

  let statusText: string;
  switch (result.status) {
    case "idle":
      statusText = t("search.idle");
      break;
    case "too_short":
      statusText = t("search.hintMinLength", { min: SITE_SEARCH_MIN_QUERY_LENGTH });
      break;
    case "too_long":
      statusText = t("search.hintMaxLength", { max: SITE_SEARCH_MAX_QUERY_LENGTH });
      break;
    case "unavailable":
      statusText = t("search.unavailable");
      break;
    default:
      statusText = hasResults ? t("search.resultsHeading", { query }) : t("search.empty", { query });
  }

  return (
    <SiteShell locale={locale} chrome={chrome}>
      <Container>
        <header className="border-b border-novel-border pt-12 pb-8 md:pt-20 md:pb-10">
          <h1 className="font-novel-serif text-3xl leading-tight font-semibold tracking-tight text-balance text-novel-fg md:text-[2.5rem]">
            {t("search.title")}
          </h1>

          <SearchForm
            defaultValue={query}
            label={t("search.inputLabel")}
            placeholder={t("search.inputPlaceholder")}
            submitLabel={t("search.submit")}
            maxLength={SITE_SEARCH_MAX_QUERY_LENGTH}
          />

          <p role="status" className="mt-5 text-base text-novel-fg-muted">
            <span>{statusText}</span>
            {hasResults ? (
              <span className="ms-3 text-sm text-novel-fg-subtle tabular-nums">
                {t("collection.workCount", { count: result.totalCount })}
              </span>
            ) : null}
          </p>

          {isEmpty ? (
            <p className="mt-2 text-sm text-novel-fg-muted">
              <Link
                href={`${localePrefix(locale)}/browse`}
                className="underline underline-offset-4 hover:text-novel-fg"
              >
                {t("search.emptyHint")}
              </Link>
            </p>
          ) : null}
        </header>

        {hasResults ? (
          <>
            <div className="pt-10 md:pt-14">
              <BookGrid locale={locale} novels={result.items} />
            </div>
            <Pagination
              locale={locale}
              currentPage={result.page}
              totalPages={result.totalPages}
              basePath={`${localePrefix(locale)}/search`}
              searchParams={{ q: query }}
              prefetch={false}
            />
          </>
        ) : null}
      </Container>
    </SiteShell>
  );
}
