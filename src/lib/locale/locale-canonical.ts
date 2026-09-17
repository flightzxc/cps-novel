/**
 * 上游语种码 → 站点 locale 的**唯一**映射，以及站点 locale 登记表的唯一真源。
 *
 * L10N P4（2026-09-10，`施工提示词_Sonnet_L10N_P4_公开面两层分层与白名单删除_2026-09-10.md`）：
 * 发布白名单层（`PUBLISHABLE_LOCALES`/`isPublishableLocale`/
 * `listPublishableLocales`/`pickPublishableLocale`/`ARTICLE_TEMPLATE_CRUD_LANDED`/
 * `assertPublishableLocalesFailClosed`）已整体删除，不是改造。公开面从"三层"
 * （登记 → 可发布白名单 → 实际路由）收口为 CPS 同构的"两层"：
 *
 * - **静态层** = `SITE_LOCALES`（本文件，同步、常量）——供路由/guard/canonical/
 *   sitemap 默认/IndexNow 资格/hreflang 枚举读。
 * - **动态层** = `getActiveLocales()`（`./active-locales.ts`，异步、按公开可见
 *   谓词族 + `unstable_cache` 300s）——供 LocaleSwitcher 等"这个语种现在有没有
 *   真实内容"的消费点读。
 *
 * 两层不是"登记 vs 可发布"的重新命名——白名单层是一道独立于两者的第三层
 * fail-closed 闸门（D-7 五项准入 + S14 模块加载期断言），本身已随删除一并
 * 撤销；两层各自的语义边界见 `./active-locales.ts` 模块头。
 *
 * 对外两个函数：
 *
 * ```
 * resolveSiteLocale(upstreamLanguageCode, upstreamLanguageName?)
 *   → { locale: string | null; confidence: "code" | "name_alias" | "unknown" }
 * ```
 *
 * （`getActiveLocales()` 是第二个对外接口，住在 `./active-locales.ts`，不在
 * 本文件——它需要 `unstable_cache`/Prisma，本文件保持同步、零 IO。）
 *
 * 🔴 **全项目唯一的语种映射实现。** 任何其他位置出现第二份语种映射硬编码都是违规：
 * CPS 因映射散落四处，付过两次全库 normalize 的代价。上游码表本身现在住在
 * `./channel-language.ts`（值来自
 * `docs/governance/L10N_UPSTREAM_LANGUAGE_EVIDENCE_2026-09-10.md` 的真实成对
 * 证据），`locale-canonical.ts` 只做"委托 + 对外签名"这一层，不重复维护码表。
 *
 * ## 三条不可协商的语义（更新）
 *
 * 1. **映射不到就是 `locale: null`**（不再是字面串 `"unknown"`）——不猜测、
 *    不做区域回退、不拿上游原值当 locale。`locale: null` 的后果是 SourceItem
 *    可建、Novel 不建，进人工队列；把一个猜出来的 locale 塞进去，等于让错误
 *    语种的内容直接进入可发布链路。`confidence: "unknown"` 与
 *    `locale: null` 恒等价——不存在 `locale` 非空但 `confidence` 是
 *    `"unknown"` 的组合，也不存在 `locale` 为 `null` 但 `confidence` 非
 *    `"unknown"` 的组合。
 * 2. **映射成功 ≠ 是站点语种**。`SITE_LOCALES` 成员判定是独立的第二道闸，
 *    `resolveSiteLocale` 可以合法返回一个非 `SITE_LOCALES` 成员的 locale
 *    （`it`/`fil`/`ms`/`tr`）。两道闸互不隐含，调用方必须分别检查。（L10N P4：
 *    曾经的第三道闸——发布白名单 `PUBLISHABLE_LOCALES`/`isPublishableLocale`
 *    ——已整体删除；"这个 `SITE_LOCALES` 成员现在有没有真实内容"改由动态层
 *    `./active-locales.ts` 的 `getActiveLocales()` 回答，不再是一道 fail-closed
 *    准入闸。）
 * 3. **认的是登记过的取值，不是长得像 locale 的字符串**。`"en"` 作为上游码传
 *    进来也不会被认成 `en`——上游给的是数值码，认字符串就是在猜。
 */
import {
  resolveChannelLanguage,
  type ResolvedChannelLanguageConfidence,
} from "./channel-language";

/**
 * 站点 locale。
 *
 * P0-S7a（2026-08-20）：Owner 已裁决——首批注册即对齐短剧站 15 语（登记 ≠
 * 活跃，见 `./active-locales.ts` 的动态层）。列表逐字取自 CPS 短剧站
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

/** 站点已登记的全部 locale（15 语，对齐短剧站）。动态层活跃集是它的子集（见 `./active-locales.ts`）。 */
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
 * `SiteLocale` → 后台展示用中文标签。P2-02B（模板管理表单）新增：语种下拉需要
 * 给运营看中文而不是裸 BCP-47 码，但下拉**提交**的值仍是 `SiteLocale` 字符串本身
 * （与 CPS `src/lib/constants.ts` 的 `LOCALE_LABEL` 同一约定——文案只影响展示，
 * 从不影响传输/存储的取值）。
 *
 * 🔴 只能加在这个唯一真源文件里，不建第二张表——`tests/ui/locale-canonical.test.ts`
 * 的"没有第二张语种映射表"扫描按名字（含 LOCALE/LANGUAGE）+ 字面量集合声明识别，
 * 排除的只有 `CANONICAL_PATH` 本身这一个文件。
 */
export const SITE_LOCALE_LABELS: Readonly<Record<SiteLocale, string>> = Object.freeze({
  en: "英文",
  es: "西班牙文",
  "pt-BR": "葡萄牙文",
  id: "印尼文",
  vi: "越南文",
  th: "泰文",
  ja: "日文",
  ko: "韩文",
  "zh-Hant": "繁体中文",
  ar: "阿拉伯文",
  fr: "法文",
  de: "德文",
  pl: "波兰文",
  cs: "捷克文",
  ru: "俄文",
});

/**
 * `SiteLocale` → 该语种的本族语自称（"Français"、"日本語"……），供公开站的
 * 语言切换器（WO-2 `施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.3）
 * 显示——与上面 `SITE_LOCALE_LABELS`（后台运营看的中文标签）是两张不同的表：
 * 那张给后台操作员，这张给读者本人在切换器里认出自己的语言。
 *
 * 🔴 只能加在这个唯一真源文件里，理由与 `SITE_LOCALE_LABELS` 完全一样：
 * `tests/ui/locale-canonical.test.ts` 的"没有第二张语种映射表"扫描按
 * 名字（含 LOCALE/LANGUAGE）+ 字面量集合声明识别，排除的只有本文件；
 * `tests/ui/public-copy-cjk.test.ts` 的公开面 CJK 扫描也不覆盖本文件——这张
 * 表本身就是"本族语文字"，两条既有门禁都只认这一个安全存放点。
 */
export const SITE_LOCALE_NATIVE_NAMES: Readonly<Record<SiteLocale, string>> = Object.freeze({
  en: "English",
  es: "Español",
  "pt-BR": "Português",
  id: "Bahasa Indonesia",
  vi: "Tiếng Việt",
  th: "ไทย",
  ja: "日本語",
  ko: "한국어",
  "zh-Hant": "繁體中文",
  ar: "العربية",
  fr: "Français",
  de: "Deutsch",
  pl: "Polski",
  cs: "Čeština",
  ru: "Русский",
});

/**
 * `resolveSiteLocale`'s return shape — CPS `ChannelLanguageResolution`
 * narrowed to just the two fields any caller actually needs: the resolved
 * locale (or `null` when unresolved) and how it was resolved. `warning`
 * (the `code_name_conflict` circuit-breaker signal) is deliberately NOT part
 * of this public shape — it only matters to a batch-level caller running
 * `evaluateLanguageMappingSuspensions` over many resolutions at once
 * (`worker/handlers/moboreader.ts`, `scripts/l10n/backfill-source-item-locale.ts`),
 * and those callers use `./channel-language.ts`'s `resolveChannelLanguage`
 * directly rather than this wrapper for exactly that reason.
 */
export type SiteLocaleResolution = {
  readonly locale: string | null;
  readonly confidence: ResolvedChannelLanguageConfidence;
};

function asChannelLanguageCode(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function asChannelLanguageName(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * 上游语种码 → 站点 locale。委托 `./channel-language.ts` 的
 * `resolveChannelLanguage`（固定 `sourceAppCode: "moboreader"`，本仓唯一上游
 * 来源）。映射不到返回 `{ locale: null, confidence: "unknown" }`。
 *
 * `upstreamLanguageName` 是第二参数，只作为**已登记文案**的备用键（先按码查，
 * 查不到再按名称别名查），绝不用来做模糊匹配或推断：它是上游文案，不是
 * locale。非 `string`/`number` 的 `upstreamLanguageCode`（对象、数组、
 * `boolean`、`NaN` 等）一律当作"没有码"处理，不抛错——继续按名称兜底，两者
 * 都对不上就是 `unknown`。
 */
export function resolveSiteLocale(
  upstreamLanguageCode: unknown,
  upstreamLanguageName?: unknown,
): SiteLocaleResolution {
  const resolution = resolveChannelLanguage({
    sourceLanguageCode: asChannelLanguageCode(upstreamLanguageCode),
    sourceLanguageName: asChannelLanguageName(upstreamLanguageName),
  });
  return { locale: resolution.locale, confidence: resolution.confidence };
}

/**
 * ---------------------------------------------------------------------------
 * 标签译名域（Tag Translation Domain）—— P2-06.5 F3。
 *
 * 🔴 这是与上面 `SiteLocale` / `SITE_LOCALES` **完全不同的第二个域**，不要合并
 * 也不要互相推导：
 *
 * - `SITE_LOCALES` 回答「本站现在可以把哪个 locale 的页面发布给读者」——
 *   fail-closed，目前只有 `en` 一项，且新增需要 Owner 决策（见上文）。
 * - `TAG_TRANSLATION_LOCALES` 回答「CanonicalTag 的译名可以录入哪些语种」——
 *   这是运营在后台给标签（一个未来面向用户检索/浏览的公共 taxonomy）录入
 *   多语展示名时能选的固定语种表，跟站点发布白名单没有从属或推导关系：
 *   一个 locale 完全可以在这张表里、却不在 `SITE_LOCALES`（甚至永远不会进
 *   入后者），反之亦然。
 *
 * 用途是 admin 端 CanonicalTag 编辑器（`LocaleFieldEditor`）：把原来的自由
 * 文本 locale 输入换成这张固定列表，从结构上消灭「运营手打错一个字母，
 * 静默产生一个没有任何校验拦截的孤儿语种译名」这类错误——CPS 生产实现
 * （`tags/_components/locale-field-editor.tsx`）已验证过这个交互模式。
 *
 * 20 项 = CPS 现行 19 码 + Novel 所需的 `zh`。
 *
 * 🔴 `zh` 在这张表里不是普通一项：它是 canonical taxonomy v1 目前**唯一**
 * 实际有数据的语种，也是查询 resolver 的全局回退——
 * `src/server/tagging/service.ts:141,254` 的
 * `COALESCE(requested.display_name, zh.display_name, ct.slug)` 把 `'zh'`
 * 硬编码成兜底键。这张表里少了 `zh`，admin 就没有任何入口能编辑这个兜底
 * 语种；一旦某个标签的 `zh` 译名缺失或需要改，整条标签的中文展示名会退化
 * 成 slug。所以 `zh` 必须始终可达、可编辑，不能被「默认收起」逻辑挡住编辑
 * 入口——它就在 `TAG_TRANSLATION_DEFAULT_EXPANDED` 里，默认展开。
 * ---------------------------------------------------------------------------
 */

/** CanonicalTag 译名可以录入的固定语种表。admin 端不提供此列表之外的输入。 */
export const TAG_TRANSLATION_LOCALES = [
  "en", "zh", "zh-CN", "zh-TW", "ja", "ko", "es", "fr", "de", "pt",
  "it", "ru", "ar", "th", "vi", "id", "ms", "tr", "pl", "nl",
] as const; // 20 项 = CPS 现行 19 码 + Novel 所需 zh

/**
 * 默认展开的语种（其余折叠，按钮渐进展开）。`zh` 必须在这里——见上方关于
 * resolver 回退的说明；`en` 是 CPS 参考实现里同样默认展开的第二语种。除这
 * 两项外，任何已有非空译名的语种也会在渲染时被强制展开，见
 * `LocaleFieldEditor` 的实现。
 */
export const TAG_TRANSLATION_DEFAULT_EXPANDED = ["zh", "en"] as const;

/** 语种码 → 该语种的母语名。用作 admin 输入框的 placeholder，不是选项文案。 */
export const TAG_LOCALE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  en: "English", zh: "中文", "zh-CN": "简体中文", "zh-TW": "繁體中文",
  ja: "日本語", ko: "한국어", es: "Español", fr: "Français", de: "Deutsch",
  pt: "Português", it: "Italiano", ru: "Русский", ar: "العربية", th: "ไทย",
  vi: "Tiếng Việt", id: "Bahasa Indonesia", ms: "Bahasa Melayu",
  tr: "Türkçe", pl: "Polski", nl: "Nederlands",
});
