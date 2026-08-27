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
 * P0-S15（2026-08-26）：上游登记表首次填充，依据《C2 真上游只读诊断报告
 * 2026-08-26》的真实成对证据登记了 `3 → en`、`7 → ru`（逐条来源见下方
 * `UPSTREAM_LANGUAGE_REGISTRY` 的内联注释）。**这只是 20 条样本覆盖到的子集，
 * 不是完整上游枚举**——未登记的数值码依旧落 `unknown`，fail-closed 语义不变。
 * 发布白名单是独立的第二道闸（登记 ≠ 可发布）；U6 已按 Owner D-7 明示放行
 * `en`，其余 14 语仍不在白名单。
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
 * P0-S15（2026-08-26）：**已按真实上游证据填入子集，不再是空表。** 来源是
 * 《C2 真上游只读诊断报告 2026-08-26》（执行基线 `d103cf2`，真实 `getlistpc`
 * 接口 20 条样本）：`$.data.list[*].language` 20 条全为 number，标量集合
 * `{3, 7}`；`$.data.list[*].languageName` 20 条全为 string，集合
 * `{英语, 俄语}`；`$.data.currentLanguage` 为 number `{3}`。`language` 与
 * `languageName` 逐条成对出现，且与已归档 Lane B 证据一致：`3 → 英语 → en`，
 * `7 → 俄语 → ru`。下面两条登记就是这份证据的直接转录，不做任何推断。
 *
 * 🔴 **这只是本页 20 条样本覆盖到的子集，不代表上游完整语种枚举。** 未在这份
 * /未来同等真实证据里出现过成对样本的数值码，`resolveSiteLocale` 依旧落
 * `unknown`——哪怕直觉上"像"某个语种也不得推测补齐。扩表规则不变：新增登记
 * 必须附带真实上游成对证据（数值码 + `languageName` + 二者同条目出现的原始
 * 样本引用），没有证据就是凭空发明上游契约——正是本文件开头「三条不可协商
 * 的语义」第 3 条点名禁止的那种猜测。
 */
type UpstreamLanguageRegistration = {
  readonly locale: SiteLocale;
  /** 上游 `language` 数值码。以十进制整数登记。 */
  readonly codes: readonly number[];
  /** 上游 `languageName` 文案。只做精确匹配，变体必须各自登记。 */
  readonly names: readonly string[];
};

const UPSTREAM_LANGUAGE_REGISTRY: readonly UpstreamLanguageRegistration[] = Object.freeze([
  {
    locale: "en",
    // 证据：《C2 真上游只读诊断报告 2026-08-26》真实 getlistpc 20 条样本
    // （基线 d103cf2）—— language=3 与 languageName="英语" 逐条成对出现，
    // currentLanguage 同样为 3；与已归档 Lane B 成对证据一致。
    codes: [3],
    names: ["英语"],
  },
  {
    locale: "ru",
    // 证据同上——language=7 与 languageName="俄语" 逐条成对出现，
    // 与已归档 Lane B 成对证据一致。
    codes: [7],
    names: ["俄语"],
  },
  // TODO: X8 验收报告的 getlistpc 样本出现过 `language=5`（`5 → unknown → 4`），
  // 但没有成对 `languageName`，因此不登记。C2b 不能当这条码的来源：它是
  // getchapterinfo 形态诊断，请求坐标 `language:number` 未记值，响应侧只有
  // `currentLanguage`。闭合此项需新探针——X8 的 harness / 坐标 / 形态产物已按
  // 纪律删除，回读旧报告拿不到 languageName。未证不得猜，5 继续落 unknown。
]);

/**
 * 发布白名单。
 *
 * U6（2026-08-27）：Owner 明示 D-7 放行 `en`。D-7 五项准入按现状重写：
 *
 * 1. 前台 messages 无 fallback——**已满足（U3）**。`src/lib/locale/messages/en.ts`
 *    是完整英文目录；公开渲染树不再混中文占位。他语是 `Partial<Messages>`，
 *    `loadMessages` 对不完整目录抛错而不是静默拼 en——这是 fail-closed，不是
 *    把中文塞进 en 页。
 * 2. 后台模板语种枚举已登记——**已满足（S9）**。内置模板覆盖 `en`；
 *    `ARTICLE_TEMPLATE_CRUD_LANDED` 仍为 `false`，所以 S14 守卫仍只允许空集
 *    或 `{"en"}` 的子集——本次放行正好是这个子集，不会触发守卫。
 * 3. 该语种模板已跑通真实渲染——**已满足（S9 端到端）**。
 * 4. SEO 元数据齐全——**已满足（S7a）**：hreflang 发布状态过滤、sitemap 分语种
 *    分片、canonical 单一源。
 * 5. sitemap 分片已验证——**已满足（X8 真实拓扑）**。
 *
 * 映射成功 ≠ 可发布：`3 → en` 现可发布；`7 → ru` 仍映射成功、仍不在白名单。
 * 非 `en` 语种在 `ARTICLE_TEMPLATE_CRUD_LANDED` 翻转前仍不得进入本表。
 */
const PUBLISHABLE_LOCALES: readonly SiteLocale[] = Object.freeze(["en"]);

/**
 * D-7 条件二 fail-closed 守卫（模块加载即断言，不是运行时才发现）。
 *
 * 背景：CPS `v6.0.4` 事故——只注册了前台 locale，漏了后台模板枚举，某语种
 * 页面裸奔上线才被发现。本仓库 D-7 条件二（"后台模板语种枚举已登记"）今天
 * 对 `en` 之所以不炸，是因为消息目录里内置了 `en` 默认文案——Opus 终审的
 * 裁定原话是：这份安全**是巧合，不是机制**，`ArticleTemplate` CRUD 一旦落地、
 * 有人往 `PUBLISHABLE_LOCALES` 里加一个非 `en` 语种，没有任何东西会拦住它，
 * 直到模板引擎在生产渲染时找不到模板才会现形。
 *
 * 这道守卫把"巧合"钉成"机制"：只要模板 CRUD 没落地，`PUBLISHABLE_LOCALES`
 * 就只能是空集，或者是 `{"en"}` 的子集；越界的化，模块一加载就抛，不允许
 * 悄悄发布到运行时才炸。
 */
export function assertPublishableLocalesFailClosed(
  locales: readonly SiteLocale[],
  articleTemplateCrudLanded: boolean,
): void {
  if (articleTemplateCrudLanded) {
    // 条件二已经有真实机制兜底（模板引擎读真实枚举），不再需要这道临时闸。
    return;
  }
  const outOfBounds = locales.filter((locale) => locale !== "en");
  if (outOfBounds.length > 0) {
    throw new Error(
      "D-7 条件二 fail-closed 守卫触发：ARTICLE_TEMPLATE_CRUD_LANDED=false 时，" +
        `PUBLISHABLE_LOCALES 只能是空集或 {"en"} 的子集，发现越界 locale：` +
        `${outOfBounds.join(", ")}。ArticleTemplate CRUD 未落地前，任何非 en ` +
        "语种都不得进入发布白名单——这正是 CPS v6.0.4 事故的形状（只注册前台 " +
        "locale，漏了后台模板枚举），不要在本仓库重演。",
    );
  }
}

/**
 * `ArticleTemplate` CRUD 是否已经落地为真实机制（表有数据、且模板引擎在渲染时
 * 真的读它，不是"表存在于 schema"这种字面意义的落地）。
 *
 * 🔴 翻转条件：等 P2-02 模板引擎接线、且某 locale 在 `ArticleTemplate` 里有
 * 真实枚举记录并被渲染路径实际读取之后，由那次改动的作者把这个常量改成
 * `true`——同一次改动必须在 PR/commit 描述里说明是哪次改动让 D-7 条件二/三
 * 成立，不能只改一个布尔值就算数。改的时候只能改这一处，不能在别处另开关。
 */
export const ARTICLE_TEMPLATE_CRUD_LANDED = false;

assertPublishableLocalesFailClosed(PUBLISHABLE_LOCALES, ARTICLE_TEMPLATE_CRUD_LANDED);

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
