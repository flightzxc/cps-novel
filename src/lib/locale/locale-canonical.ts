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
 * 🔴 目前只有 `en`：它是本仓库里唯一有依据的站点语种（根布局 `<html lang="en">`），
 * 也是 D-7 建议的起步语种。**新增任何 locale 必须先有 Owner 决策**，
 * 且只能改这一个文件。
 */
export type SiteLocale = "en";

/** 站点已登记的全部 locale。发布白名单是它的子集。 */
export const SITE_LOCALES: readonly SiteLocale[] = Object.freeze(["en"]);

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
 * 🔴 **当前为空，同样是有意的。** D-7（首发公开语种白名单）仍是 OPEN，且冻结的
 * 准入条件是五项齐备：前台 messages 无 fallback · 后台模板语种枚举已登记 ·
 * 该语种模板已跑通真实渲染 · SEO 元数据齐全 · sitemap 分片已验证。P1 阶段一项
 * 都不具备，所以连 `en` 也不进白名单——CPS `v6.0.4` 就是只注册了前台 locale、
 * 漏了后台模板枚举，线上才发现。
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
