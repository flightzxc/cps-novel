/**
 * 上游语种码 → 站点 locale 的**唯一**映射，以及发布白名单的查询入口。
 *
 * 契约：`docs/p1/P1_SHARED_CONTRACTS.md` §2（级别 `FROZEN`，硬前置 2）与本目录
 * `README.md`。对外只有三个函数，签名逐字照抄冻结契约：
 *
 * ```
 * resolveSiteLocale(upstreamLanguageCode, upstreamLanguageName?) → SiteLocale | "unknown"
 * isPublishableLocale(locale) → boolean
 * listPublishableLocales() → SiteLocale[]
 * ```
 *
 * 🔴 **全项目唯一的语种映射实现。** 任何其他位置出现第二份语种映射硬编码都是违规：
 * CPS 因映射散落四处，付过两次全库 normalize 的代价。
 *
 * ## 三条不可协商的语义
 *
 * 1. **映射不到就是 `unknown`**——不猜测、不做区域回退、不拿上游原值当 locale。
 *    `unknown` 的后果是 SourceItem 可建、Novel 不建，进人工队列；把一个猜出来的
 *    locale 塞进去，等于让错误语种的内容直接进入可发布链路。
 * 2. **映射成功 ≠ 可发布**。白名单是独立的第二道闸，且 fail-closed。
 * 3. **认的是登记过的取值，不是长得像 locale 的字符串**。`"en"` 作为上游码传进来
 *    也不会被认成 `en`——上游给的是数值码，认字符串就是在猜。
 */

/**
 * 站点 locale。
 *
 * P0-S7a（2026-08-20）：Owner 已裁决——首批注册即对齐短剧站 15 语（登记 ≠
 * 可发布，见下方 `PUBLISHABLE_LOCALES`）。列表逐字取自 CPS 短剧站
 * `src/lib/supported-site-locales.ts` 的 `SUPPORTED_SITE_LOCALES`
 * （`git show v8.2.10:src/lib/supported-site-locales.ts`，仓库路径
 * `/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin`，只读参考，
 * 未改动该仓库任何文件）。CPS 该文件里 `pt`→`pt-BR`、`zh-TW`→`zh-Hant` 是别名
 * 折叠规则，不是独立 locale，因此不登记为本站点的第 16、17 个 locale。
 *
 * 🔴 **新增/删减任何 locale 必须先有 Owner 决策，且只能改这一个文件**——
 * 这条纪律不因登记表从 1 项扩到 15 项而改变。
 */
export type SiteLocale =
  | "en"
  | "es"
  | "pt-BR"
  | "id"
  | "vi"
  | "th"
  | "ja"
  | "ko"
  | "zh-Hant"
  | "ar"
  | "fr"
  | "de"
  | "pl"
  | "cs"
  | "ru";

/** 站点已登记的全部 locale（15 语，对齐短剧站）。发布白名单是它的子集。 */
export const SITE_LOCALES: readonly SiteLocale[] = Object.freeze([
  "en",
  "es",
  "pt-BR",
  "id",
  "vi",
  "th",
  "ja",
  "ko",
  "zh-Hant",
  "ar",
  "fr",
  "de",
  "pl",
  "cs",
  "ru",
]);

/**
 * 上游语种登记表：一个站点 locale ← 一组上游取值。
 *
 * 🔴 **当前为空，这是有意的，不是漏写。** 上游 `language` 是数值码，其枚举来自
 * 接口探测证据（`P0_BROWSER_INTERFACE_PROBE.md` / `P0_SECOND_BROWSER_PROBE.md`），
 * 而这两份证据不在本仓库内；`novel-v1-adapter-and-workflow` §U-3 还明确记着
 * 「法语的 `language` 数值枚举未安全取得」。没有证据就登记数值码，等于凭空发明
 * 上游契约——正是契约里点名禁止的那种猜测。
 *
 * 于是今天 `resolveSiteLocale` 对任何输入都返回 `unknown`，链路 fail-closed：
 * SourceItem 可建、Novel 不建、进人工队列。证据到手后，唯一要改的就是这张表。
 */
type UpstreamLanguageRegistration = {
  readonly locale: SiteLocale;
  /** 上游 `language` 数值码。以十进制整数登记。 */
  readonly codes: readonly number[];
  /** 上游 `languageName` 文案。只做精确匹配，变体必须各自登记。 */
  readonly names: readonly string[];
};

const UPSTREAM_LANGUAGE_REGISTRY: readonly UpstreamLanguageRegistration[] = Object.freeze([]);

/**
 * 发布白名单。
 *
 * 🔴 **P0-S7a 复核后依旧为空——连 `en` 都不进，这是本轮逐条核对五项准入条件
 * 后的结论，不是沿用旧状态没检查。** D-7（`docs/architecture/candidate-v0.2.1/
 * novel-v1-open-decisions.md`）冻结的准入条件是五项齐备：
 *
 * 1. 前台 messages 无 fallback——**不满足**。本仓库没有任何 messages 目录/i18n
 *    目录；且公开路由的实际渲染树里混着大量中文占位文案（例如
 *    `src/app/browse/page.tsx` 的 `title="全部作品"`、
 *    `src/features/public-ui/status/UnavailableScreen.tsx` 的
 *    `"这本书暂时不可阅读"`、`src/features/public-ui/layout/SiteHeader.tsx`
 *    的 `aria-label="主导航"` 等——不是「en 缺文案」，是「en 页面里本就还有非
 *    en 文案」，五项里最硬的一条直接不成立。这部分工作在 Cursor 的 U3。
 * 2. 后台模板语种枚举已登记——**不满足**。`ArticleTemplate` 表存在于 schema，
 *    但本仓库没有任何代码引用它；模板引擎尚未接线（P2-02 在独立分支，未进本
 *    基线），无枚举可言。
 * 3. 该语种模板已跑通真实渲染——**不满足**，前提条件 2 都不成立。
 * 4. SEO 元数据齐全——P0-S7a 本单把这块基础设施补齐了（hreflang 发布状态过滤、
 *    sitemap 分语种分片、canonical 单一源），但条件 1-3 仍卡关，单独满足条件
 *    4 不能让任何 locale 通过「五项齐备」的准入线。
 * 5. sitemap 分片已验证——本单验证的是分片**逻辑**（多 locale 参数化路径，见
 *    `tests/backend/seo/`），不是针对真实生产内容的验证；`listPublishableLocales()`
 *    仍为空时 `generateStaticSitemaps` 会直接失败（`No sitemap child files
 *    were generated`），这本身就是 fail-closed 的证据而非缺陷。
 *
 * 结论：15 语没有一个满足全部五项，`en` 也不例外——CPS `v6.0.4` 就是只注册了
 * 前台 locale、漏了后台模板枚举，线上才发现；宁可继续 fail-closed，也不要重
 * 复那次事故。表一旦有 locale 真正五项齐备，只改这一个文件。
 */
const PUBLISHABLE_LOCALES: readonly SiteLocale[] = Object.freeze([]);

const CODE_INDEX: ReadonlyMap<string, SiteLocale> = new Map(
  UPSTREAM_LANGUAGE_REGISTRY.flatMap((entry) =>
    entry.codes.map((code) => [String(code), entry.locale] as const),
  ),
);

const NAME_INDEX: ReadonlyMap<string, SiteLocale> = new Map(
  UPSTREAM_LANGUAGE_REGISTRY.flatMap((entry) =>
    entry.names.map((name) => [name, entry.locale] as const),
  ),
);

const PUBLISHABLE_INDEX: ReadonlySet<string> = new Set(PUBLISHABLE_LOCALES);

/**
 * 上游数值码的查表键。
 *
 * 只认十进制整数，以及它逐字相同的字符串写法（JSON 里同一个码有时是 `3`
 * 有时是 `"3"`）。`3.0`、`"03"`、`" 3"`、`"0x3"`、`true` 一律不认——把它们
 * 折算成 3 就是在替上游做决定。
 */
function codeKey(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : null;
  }
  if (typeof value === "string") {
    return /^(?:0|[1-9]\d*)$/.test(value) ? value : null;
  }
  return null;
}

/** 上游语种文案的查表键：逐字精确，大小写敏感。变体必须在登记表里各自登记。 */
function nameKey(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 上游语种码 → 站点 locale。映射不到返回 `unknown`。
 *
 * `upstreamLanguageName` 是冻结签名里的第二参数，只作为**已登记文案**的备用键，
 * 绝不用来做模糊匹配或推断：它是上游文案，不是 locale。
 */
export function resolveSiteLocale(
  upstreamLanguageCode: unknown,
  upstreamLanguageName?: unknown,
): SiteLocale | "unknown" {
  const code = codeKey(upstreamLanguageCode);
  if (code !== null) {
    const byCode = CODE_INDEX.get(code);
    if (byCode !== undefined) {
      return byCode;
    }
  }

  const name = nameKey(upstreamLanguageName);
  if (name !== null) {
    const byName = NAME_INDEX.get(name);
    if (byName !== undefined) {
      return byName;
    }
  }

  return "unknown";
}

/**
 * 该 locale 是否可以公开发布。
 *
 * 逐字精确匹配：`"EN"`、`"en-US"`、`"en_US"` 都是 `false`。大小写折叠与区域回退
 * 都属于「替调用方猜」，而这道闸的默认必须是拒绝——站内生产者本来就只产出
 * 规范 locale，能走到这里的变体只可能来自外部输入。
 */
export function isPublishableLocale(locale: unknown): boolean {
  return typeof locale === "string" && PUBLISHABLE_INDEX.has(locale);
}

/**
 * 全部可发布 locale，供 sitemap 分片与语言聚合使用。
 *
 * 返回副本：调用方拿到的数组改不动真源。
 */
export function listPublishableLocales(): SiteLocale[] {
  return [...PUBLISHABLE_LOCALES];
}
