/**
 * Shared SEO primitives for metadata templates.
 *
 * Ported from CPS `src/lib/seo-templates/_shared.ts` (d77c3b9).
 * PulseDrama brand constants and the CPS default domain are not ported.
 */

const OPEN_GRAPH_TAGS: Record<string, string> = {
  en: "en_US",
  "zh-CN": "zh_CN",
  "zh-TW": "zh_TW",
  "zh-Hant": "zh_TW",
  ja: "ja_JP",
  ko: "ko_KR",
  es: "es_ES",
  fr: "fr_FR",
  de: "de_DE",
  pt: "pt_BR",
  "pt-BR": "pt_BR",
  it: "it_IT",
  ru: "ru_RU",
  ar: "ar_SA",
  th: "th_TH",
  vi: "vi_VN",
  id: "id_ID",
  ms: "ms_MY",
  tr: "tr_TR",
  pl: "pl_PL",
  cs: "cs_CZ",
  nl: "nl_NL",
};

// Single source (v0.2.0 integration): `src/lib/seo/site-url.ts` is the only
// implementation of getSiteUrl/SiteUrlConfigurationError in this repo, per the
// round's arbitration. This module re-exports for existing consumers; the
// former local duplicate (semantically identical) was removed as planned by
// the TODO it carried.
import { getSiteUrl, SiteUrlConfigurationError, toAbsoluteUrl } from "@/lib/seo/site-url";

export { getSiteUrl, SiteUrlConfigurationError, toAbsoluteUrl };

/** Truncate text to maxLen, ending at word boundary with ellipsis. */
export function truncateDescription(text: string, maxLen = 155): string {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen);
  const last = cut.lastIndexOf(" ");
  return (last > maxLen * 0.6 ? cut.slice(0, last) : cut) + "…";
}

/** CPS `toOgLocale` renamed so it does not look like a second locale mapper. */
export function openGraphLocaleTag(locale: string): string {
  return OPEN_GRAPH_TAGS[locale] || "en_US";
}

/** Build absolute canonical URL for a path. */
export function buildCanonical(path: string): string {
  const siteUrl = getSiteUrl();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${siteUrl}${normalized}`;
}

/**
 * Build locale-aware absolute canonical URL.
 * `en` has no path prefix (localePrefix: "as-needed").
 * Other locales get /<locale>/ prefix. Root "/" becomes "/<locale>".
 */
export function buildLocaleCanonical(locale: string, path: string): string {
  const siteUrl = getSiteUrl();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (locale === "en") return `${siteUrl}${normalized}`;
  if (normalized === "/") return `${siteUrl}/${locale}`;
  return `${siteUrl}/${locale}${normalized}`;
}

/** Resolve OG image to absolute URL. Missing image + missing fallback fails closed. */
export function resolveOgImage(imageUrl?: string | null, fallback?: string | null): string {
  const resolved = toAbsoluteUrl(imageUrl ?? undefined) ?? toAbsoluteUrl(fallback ?? undefined);
  if (!resolved) {
    throw new Error("OG image is required: pass coverUrl or defaultOgImage");
  }
  return resolved;
}

/** 站点默认分享图的固定尺寸：`public/brand/og-default.png` 实测 1200×630。 */
export const SITE_DEFAULT_OG_IMAGE_WIDTH = 1200;
export const SITE_DEFAULT_OG_IMAGE_HEIGHT = 630;

/** `og:image` 的一条声明。`width`/`height` 只在尺寸**确知**时才声明。 */
export interface OpenGraphImage {
  url: string;
  alt: string;
  width?: number;
  height?: number;
}

export type ShareImageKind = "site-default" | "cover";

export interface ShareImage {
  /** 绝对地址。JSON-LD 的 `image` 也用它。 */
  url: string;
  /** 最终选中的是站点默认图还是书封。 */
  kind: ShareImageKind;
  /** `twitter:card`：站点默认图 → `summary_large_image`；书封 → `summary`。 */
  twitterCard: "summary_large_image" | "summary";
  /** 直接放进 `openGraph.images`。 */
  openGraphImages: OpenGraphImage[];
}

export interface ShareImageInput {
  /** 书封（可为相对路径，会转成绝对地址）。 */
  coverUrl?: string | null;
  /** 站点默认分享图（后台 `SiteSetting.defaultOgImage`）。 */
  defaultOgImage?: string | null;
  /**
   * 两者都可用时选哪个。
   *   - `"cover"`（默认）：小说页、章节页——书封优先，站点默认图兜底；
   *   - `"default"`：首页、浏览页、分类页——站点默认图优先，`coverUrl` 只是默认图缺失时
   *     拿「列表第一本」书封兜底。
   * 这两个优先级原样沿用此前各页面的取值顺序，本函数只新增「选中的是哪一种」的判定。
   */
  prefer?: "cover" | "default";
  /** og:image 的 alt。 */
  alt: string;
}

/**
 * 解析最终分享图，并按「最终选中的是哪一种」统一给出卡片口径（B-37，2026-10-07）。
 *
 * 为什么要按种类区分：此前所有模板都把分享图声明成 `1200×630` +
 * `twitter:card = summary_large_image`，但书封实际是 **250×350**，宽度低于 X 大图卡片
 * 的最小宽度（300）——声明了假尺寸，平台要么拒绝大图卡片、要么把竖封面拉伸裁切。
 *
 *   - 站点默认图（`og-default.png`，1200×630）：保持 `summary_large_image` +
 *     `width: 1200, height: 630`；
 *   - 书封：`twitter:card = summary`（小图卡片），og:image **不声明** width/height
 *     （尺寸并不是 1200×630，不能谎报；不声明时由平台自己抓取探测）。
 *
 * 所有用到 `resolveOgImage` 语义的模板都走这一个函数，不要在模板里各写一份判断。
 * 两者都缺失时与 `resolveOgImage` 一样 fail closed。
 * 博客模板同样走本函数（PN-12）：博客封面是运营上传的，尺寸未知，按"非默认图"口径处理
 * （`summary`、不声明尺寸）；没有封面才落到站点默认图的大卡片。
 */
export function resolveShareImage(input: ShareImageInput): ShareImage {
  const cover = toAbsoluteUrl(input.coverUrl ?? undefined);
  const siteDefault = toAbsoluteUrl(input.defaultOgImage ?? undefined);

  const picked: { url: string; kind: ShareImageKind } | undefined =
    input.prefer === "default"
      ? siteDefault
        ? { url: siteDefault, kind: "site-default" }
        : cover
          ? { url: cover, kind: "cover" }
          : undefined
      : cover
        ? { url: cover, kind: "cover" }
        : siteDefault
          ? { url: siteDefault, kind: "site-default" }
          : undefined;

  if (!picked) {
    throw new Error("OG image is required: pass coverUrl or defaultOgImage");
  }

  if (picked.kind === "site-default") {
    return {
      ...picked,
      twitterCard: "summary_large_image",
      openGraphImages: [
        {
          url: picked.url,
          width: SITE_DEFAULT_OG_IMAGE_WIDTH,
          height: SITE_DEFAULT_OG_IMAGE_HEIGHT,
          alt: input.alt,
        },
      ],
    };
  }
  return {
    ...picked,
    twitterCard: "summary",
    openGraphImages: [{ url: picked.url, alt: input.alt }],
  };
}

/**
 * Pagination pages are indexable by default; omit robots metadata.
 *
 * 分页页（第 2 页起）与第 1 页一样默认可收录：恒返回 `undefined`，由
 * `toNextMetadata` 落成 `{ index: true, follow: true }`。
 *
 * 出处：CPS 生产 tag v8.7.2（peeled `c8c7d4ed66c42395a44811262afdb84bf29a8405`）
 * `src/lib/seo-templates/_shared.ts:43-47`，函数体逐字一致。CPS 在 `ca29608`（2026-05-06，
 * "remove pagination noindex"）与 `197bb69`（2026-05-28，"allow category and tag paginated
 * pages to index"）把它从"第 2 页起 noindex"改成恒返回 `undefined`；CPS 分类、标签模板的
 * `robots` 字段都调用它（`category.ts:93`、`tag.ts:94`）。
 *
 * 本项目分类模板（`category.ts`）与列表模板（`collection.ts`，书库与博客列表共用）的
 * `robots` 字段都必须调用本函数，不得再接 `seo-utils.ts` 的 `shouldNoIndex`——那是 CPS 里
 * 已无调用方的废弃函数（v8.7.2 `seo-utils.ts:140` 仅有定义），此前被误接进两个模板，使第 2
 * 页起 noindex，与站点地图仍列出这些页的信号相矛盾（PN-01）。
 */
export function paginatedRobots(_pageNumber?: number) {
  void _pageNumber;
  return undefined;
}
