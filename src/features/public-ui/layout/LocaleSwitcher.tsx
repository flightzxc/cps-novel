"use client";

import { useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { useLocale, useOptionalLocale, useT } from "@/lib/locale/messages/MessagesProvider";
import {
  SITE_LOCALE_NATIVE_NAMES,
  SITE_LOCALES,
  type SiteLocale,
} from "@/lib/locale/locale-canonical";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import { decodeSlugParam, localePrefix } from "@/lib/slug/article-path";

/**
 * Public-site language switcher.
 *
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.3): ported from CPS
 * `src/components/site/locale-switcher.tsx` — same pure strip/build/sanitize
 * functions, same same-origin href guard, same menu semantics
 * (`role="menu"`/`menuitem`, `aria-current`, `aria-haspopup`,
 * `aria-expanded`, `useId()`-built `aria-controls`, Esc closes and returns
 * focus to the trigger, an outside click closes).
 *
 * 2026-09-30（语种切换与 404 对齐 CPS，Owner 拍板"全部照搬短剧站"）：WO-2 当时
 * 刻意没搬"同页 sibling 查找"，切换一律只把旧前缀换成新前缀、路径原样保留。
 * 这条删减本身就是缺陷——`en` 的前缀是空的，韩语书的 slug 被原样搬到英文路径
 * 下就是 404（预生产实测）。现在照搬 CPS `switchLocale`
 * （`v8.5.1:src/components/site/locale-switcher.tsx:174-234`，`3a76877`）：
 *
 * - **首页、`/browse`、`/blog` 列表**：各语种都有这个页面，保持直接切换
 *   （`/browse?category=…` 例外：分类在目标语种没有文章时就是 404，归入下一类）。
 * - **搜索页 `/search`**（PN-15）：每个语种都有搜索页，直接切换到目标语种的 `/search`，
 *   **只带 `q`、去掉 `page`**（页码在另一语种里没有意义，目标语种页数不足会 404）。这个"只带 `q`"
 *   的规则只对搜索页生效，其它页面的计划与 href 完全不变（`localeSwitchSearch`）。
 * - **书的详情页**（`/novel/{slug}`）：先问 `/api/novel-locale-check`
 *   （CPS `/api/drama-locale-check` 的移植），目标语种有这本书的公开页就直接
 *   跳过去；没有、或者接口出错，就弹提示，再跳**目标语种首页**。
 * - **其余一切**——章节页、分类页、博客文章页、404 页本身、任何未登记的路径：
 *   不查对应关系（Owner：切换语种后有没有同一本书不确定，也无法关联），
 *   直接弹提示 + 跳目标语种首页。白名单思路：只有明确知道"各语种都存在"的页面
 *   才直接切换，其它默认走保底，不会再把用户送进 404。
 *
 * 提示有两个键（Owner 2026-09-30 拍板）：书页（详情页、章节页）用
 * `localeSwitcher.fallbackToast`——以 CPS 句式为底：15 个语种里 8 个（en、ar、de、
 * es、id、ja、pt-BR、th）与 CPS v8.5.1 逐字相同；7 个偏离——zh-Hant/ru/vi 把"剧/影片"
 * 换成"作品/книга/sách"（Owner 2026-09-30），fr/ko/ru/cs/pl 因为 `{locale}` 是目标语种的
 * 本语自称、直接替换进 CPS 原句会出语法问题（fr 缺介词、ko 助词"로"写死、ru/cs/pl 自称无法
 * 变格），按第三方验收（GPT，2026-09-30）+ Owner 拍板改成与本语种 `fallbackToastPage`
 * 同一种写法（ru 两处都改，vi 另改用"Cuốn sách này"）；其它页面（分类页、博客页、404 页、
 * 未登记路径）用 `localeSwitcher.fallbackToastPage`——CPS 没有对应场景的新键
 * （"This page isn't available…"）。选哪个键由 `isBookPagePath` 决定。
 *
 * 分页等 query 参数**照 CPS 保留**：CPS 的 `switchLocale` 对非详情页走
 * `buildPathOnlyLocaleHref`，原样带上 search（和 hash），所以 `/browse?page=N`
 * 直接切过去、带着 `?page=N`——目标语种页数不足时会 404，这是登记在
 * `docs/governance/port-registry.md` 里的已知残留，不在这里另造规则。
 *
 * 两处必须交代的、与 CPS 不同的实现细节（行为等价，结构不同）：
 * 1. 提示要跨页面存活。CPS 的页头在 layout 里、导航时不重挂载，提示状态留在
 *    组件里就行；海阅的 `SiteShell` 在每个页面 body 里，`router.push` 之后
 *    切换器会重新挂载，组件内 state 会丢。所以点击时同时把提示写进
 *    `sessionStorage`（带过期时刻，总时长与 CPS 一致 3.5 秒），新页面的切换器
 *    挂载时读回来继续显示剩余时间。读写都包在 try/catch 里：存储不可用只是
 *    少一条提示，不影响跳转。
 * 2. 菜单条目仍是 `<Link href>`（不是 CPS 的 `<button>`）：保留 WO-2 的可访问
 *    语义与"新标签打开"手势。非直接切换的条目，`href` 就是目标语种首页；点击时
 *    由 `handleSwitchClick` 接管。带修饰键的点击、非左键点击一律交给浏览器。
 *
 * 也照搬了 CPS `switchLocale` 的第一行：点击时写 `NEXT_LOCALE` cookie
 * （`Path=/; Max-Age=31536000; SameSite=Lax`，与 `root-negotiation.ts` 写的同一
 * 枚 cookie、同一组属性）。没有它，Accept-Language 偏韩语的浏览器点"English"
 * 去首页 `/`，会被根路径协商立刻 307 回 `/ko`，切换器永远回不到英文首页。
 *
 * L10N P4 (2026-09-10): the selectable set is the `activeLocales` prop (from
 * `getActiveLocales()`, the dynamic layer — see
 * `src/lib/locale/active-locales.ts`), passed down from a server component
 * ancestor, rather than this component calling `listPublishableLocales()`
 * itself. `getActiveLocales()` is async (Prisma + `unstable_cache`) and
 * this component is `"use client"` (`ChapterScreen.tsx` statically imports
 * `SiteShell` from inside a client boundary) — calling it here directly
 * would drag `prisma`/`unstable_cache` into the client bundle.
 * 菜单条目 = `activeLocales` ∪ {当前语种} ∪ {`en`}——照 CPS：当前语种恒在菜单里
 * （`visible = new Set([locale])`），`en` 由动态层 `queryActiveLocales` 无条件
 * 种入（CPS `active.add("en")`），这里再兜一层，保证"英文入口始终可选"不依赖
 * 调用方传对。
 *
 * PN-09（Owner 2026-10-08：没有书时连入口也隐藏）：`activeLocales` 本来就只含"有书的语种"
 * （空语种不在里面），所以菜单**不会列出任何空语种**——这一点不需要这里再做过滤，也不要在这里
 * 另查一份"有没有书"。唯一的例外是读者当前正在看的语种：直接打开 `/cs` 这样的空语种时，
 * 当前语种仍然排在菜单里并标 `aria-current`，免得触发按钮上的语种名在菜单里找不到；其它空语种
 * 一概不列。全站只有英文有书（`activeLocales` 只剩 `["en"]`）而读者恰好在空语种页面时，
 * 菜单依然渲染（English + 当前语种），让读者有路回到英文。
 *
 * PN-15 第二批（手机端页头方案 A，Owner 2026-10-09）：语种入口有两种**展示形态**（`variant`）。
 * 逻辑（条目集合、`href`、`planLocaleSwitch` / `buildLocaleSwitchHref`、兄弟页查询、回退提示、
 * cookie）**只有一份**，两种形态共用 `LocaleSwitcherMenu` 里同一套代码，不复制：
 *
 * - `"pill"`（默认）：页头里的胶囊 + 下拉。**只在 `md` 及以上显示**——手机页头不再放语种按钮
 *   （320 宽的印尼语 "Bahasa Indonesia" 会折两行、把菜单按钮挤到 20px）。手机上它只剩一件事：
 *   提示条的挂载点。切换后的提示要在新页面挂载时读回来，而手机菜单收起时语种行根本没渲染，
 *   所以胶囊实例始终挂载（触发按钮 `display:none`，不进可访问性树），提示条在手机上改成
 *   `fixed` 贴页头下沿，`md` 起仍是原来的 `absolute` 挂在触发按钮下面。
 * - `"menuRow"`：手机菜单面板里的一行（地球图标 + `nav.language` 文案，右侧本语自称 + 下拉箭头），
 *   点开后在面板里**就地展开**同一份语种列表。展开列表不是浮层（没有 `absolute` / `z-*`）。
 *   在这一行里按 Esc 只收起它自己的列表（`stopPropagation`，不让页头把整个面板一起关掉）。
 *   跨页提示不在这个形态里读回——那是胶囊实例的事，否则同一条提示会显示两遍。
 */

// Native self-names ("Français", "日本語", …) live in `locale-canonical.ts`
// as `SITE_LOCALE_NATIVE_NAMES` — not defined here — for two reasons that
// are both existing, pre-WO-2 repo guards, not new rules invented for this
// component: (1) `tests/ui/locale-canonical.test.ts`'s "no second locale
// mapping table" scan flags any other `const ...LOCALE... = {...}`-shaped
// declaration outside that one file; (2) `tests/ui/public-copy-cjk.test.ts`
// scans this whole `src/features/public-ui` tree for hardcoded non-English
// characters, which the ja/ko/zh-Hant native names would trip. Both guards
// exempt `locale-canonical.ts` by design.

const BLOCKED_HREF_PARTS = ["localhost", "127.0.0.1", "0.0.0.0", ":3000"];
/** Recognized path-prefix codes for `stripLocalePrefix` below — the full registered set (`SITE_LOCALES`), not the narrower open/publishable one; see that function's own doc comment for why. */
const RECOGNIZED_PATH_PREFIXES = new Set<string>(SITE_LOCALES);

/** `NEXT_LOCALE` cookie：属性与 `src/lib/locale/root-negotiation.ts` 写的那枚逐项一致。 */
const COOKIE_NAME_NEXT_LOCALE = "NEXT_LOCALE";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** 提示的总展示时长，与 CPS `showToast` 的 3500ms 一致。 */
const TOAST_DURATION_MS = 3500;
const TOAST_STORAGE_KEY = "novel:locale-switch-toast";
/** 查询接口的兜底超时：超时按"出错"处理（弹提示 + 回目标首页），不让用户卡在一个永不返回的请求上。 */
const LOOKUP_TIMEOUT_MS = 5000;

function normalizePathname(pathname: string): string {
  if (!pathname) return "/";
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

/**
 * Strips a recognized locale-shaped prefix off `pathname`, if present.
 * Recognition uses the full REGISTERED locale set (`SITE_LOCALES`, D-8's
 * URL shape for all 15), not the narrower open/publishable set — this is
 * parsing, not a servability decision, and a link built from the result is
 * always re-prefixed against the caller's OWN target locale afterward, so a
 * broader recognition set here cannot widen what ends up rendered.
 *
 * `decodeURIComponent` throws a `URIError` on a malformed percent-escape
 * (`/%zz`, a truncated `/%E0%A4%A`) — this runs on every render (`usePathname()`
 * feeds straight into `buildLocaleSwitchHref` below, called once per menu
 * item), so a malformed segment must never crash the switcher. Caught and
 * treated exactly like "not a recognized locale prefix": no prefix
 * stripped, the raw path passes through untouched.
 */
export function stripLocalePrefix(pathname: string): string {
  const normalized = normalizePathname(pathname);
  const [, firstSegment = "", ...rest] = normalized.split("/");
  let decodedFirstSegment: string;
  try {
    decodedFirstSegment = decodeURIComponent(firstSegment);
  } catch {
    return normalized;
  }
  if (!RECOGNIZED_PATH_PREFIXES.has(decodedFirstSegment)) {
    return normalized;
  }
  return rest.length > 0 ? `/${rest.join("/")}` : "/";
}

/**
 * Same-origin guard for a switcher href. Anything that isn't a bare
 * site-relative path — protocol-relative (`//host`), an explicit scheme
 * (`javascript:`, `https:`, ...), or containing one of the blocked
 * host/port substrings — collapses to `/` rather than being used verbatim.
 */
export function sanitizePathOnlyHref(href: string): string {
  const lowerHref = href.toLowerCase();
  const hasBlockedPart = BLOCKED_HREF_PARTS.some((part) => lowerHref.includes(part));
  if (!href.startsWith("/") || href.startsWith("//") || /^[a-z][a-z\d+\-.]*:/i.test(href) || hasBlockedPart) {
    return "/";
  }
  return href;
}

/**
 * Builds the switch-to-`target`-locale href for the current `pathname`
 * (+ optional `search`), reusing `localePrefix` (the site's sole
 * prefix-building rule) rather than re-deriving the as-needed scheme here.
 * The root path is special-cased so switching to a non-`en` target from
 * `/` produces `/{target}`, not `/{target}/` (`localePrefix` + a bare `/`
 * suffix would otherwise double up the slash).
 *
 * 这是"直接切换"的构造器——只换前缀、路径原样保留。它本身没有问题，有问题的
 * 是把它用在"目标语种未必有这个页面"的路径上；哪些路径可以直接用它，由下面的
 * `planLocaleSwitch` 决定。
 */
export function buildLocaleSwitchHref(pathname: string, target: SiteLocale, search?: string): string {
  const bare = stripLocalePrefix(pathname);
  const prefix = localePrefix(target);
  const withPrefix = bare === "/" ? prefix || "/" : `${prefix}${bare}`;
  return sanitizePathOnlyHref(`${withPrefix}${search ?? ""}`);
}

/** 目标语种首页（`/` 或 `/{locale}`），已过同源守卫。 */
export function buildLocaleHomeHref(target: SiteLocale, search?: string): string {
  return buildLocaleSwitchHref("/", target, search);
}

/**
 * 一次语种切换该怎么走：
 * - `direct`：目标语种必定有这个页面，只换前缀；
 * - `novel`：书的详情页，先问接口有没有对应版本；
 * - `fallback`：目标语种未必有这个页面、也不去查——弹提示，回目标语种首页。
 */
export type LocaleSwitchPlan =
  | { readonly kind: "direct" }
  | { readonly kind: "novel"; readonly slugParam: string }
  | { readonly kind: "fallback" };

/**
 * 白名单：只有首页、`/browse`（不带 `category`）、`/blog` 列表明确"每个已登记
 * 语种都有"，才直接切换。`search` 只在读得到的时候（点击时）才传——渲染期读
 * `window.location` 会造成水合不一致，见 `handleSwitchClick` 里的说明。
 */
export function planLocaleSwitch(pathname: string, search?: string): LocaleSwitchPlan {
  const bare = stripLocalePrefix(pathname);
  const segments = bare.split("/").filter(Boolean);

  if (segments.length === 0) return { kind: "direct" };

  if (segments.length === 1 && segments[0] === "browse") {
    // `?category=` 的分类页在目标语种没有文章时是 404（海阅的分类空即 404），
    // 与 `/category/{slug}` 同类，走保底。
    const hasCategory = new URLSearchParams(search ?? "").has("category");
    return hasCategory ? { kind: "fallback" } : { kind: "direct" };
  }

  if (segments.length === 1 && segments[0] === "blog") return { kind: "direct" };

  // PN-15：搜索页每个语种都有（开关打开时），直接切换；带哪些参数见 `localeSwitchSearch`。
  if (segments.length === 1 && segments[0] === "search") return { kind: "direct" };

  if (segments.length === 2 && segments[0] === "novel") {
    return { kind: "novel", slugParam: decodeSlugParam(segments[1]!) };
  }

  return { kind: "fallback" };
}

/** 当前路径是不是搜索页（`/search` 或 `/{语种}/search`）。 */
function isSearchPath(pathname: string): boolean {
  const segments = stripLocalePrefix(pathname).split("/").filter(Boolean);
  return segments.length === 1 && segments[0] === "search";
}

/**
 * 切换语种时要带到目标页的 query string（含开头的 `?`，没有则空串）。
 *
 * - 搜索页：**只带 `q`**（重复时取第一个，空 `q` 不带），`page` 与其它参数一律去掉；
 * - 其它页面：原样带上（照 CPS，分页等参数保留）——与 PN-15 之前逐字一致。
 */
export function localeSwitchSearch(pathname: string, search?: string): string {
  if (!search) return "";
  if (!isSearchPath(pathname)) return search;
  const query = new URLSearchParams(search).get("q");
  return query ? `?${new URLSearchParams({ q: query }).toString()}` : "";
}

/**
 * "直接切换"的最终 href。搜索页单独处理：路径部分走 `buildLocaleSwitchHref`（过同源守卫），
 * `q` 在守卫之外追加——守卫按子串拒绝 `localhost` 等字样，搜索词里出现它们不该把读者送回首页；
 * 追加的部分是 `URLSearchParams` 编码过的，不可能构成协议头或 `//`。
 */
export function buildDirectLocaleSwitchHref(pathname: string, target: SiteLocale, search?: string): string {
  if (!isSearchPath(pathname)) return buildLocaleSwitchHref(pathname, target, search);
  return `${buildLocaleSwitchHref(pathname, target)}${localeSwitchSearch(pathname, search)}`;
}

/**
 * 书页 = 小说详情页（`/novel/{slug}`）与章节页（`/novel/{slug}/chapter/{n}`）。
 * 决定切换提示用哪个键：书页用以 CPS 句式为底的 `fallbackToast`（8 个语种与 CPS
 * 逐字相同，7 个语种换词或语法对齐，详见文件头），其它页面用 `fallbackToastPage`。
 * 与 `planLocaleSwitch` 各管一件事：一个决定"去哪儿"，一个决定"说什么"。
 */
export function isBookPagePath(pathname: string): boolean {
  const segments = stripLocalePrefix(pathname).split("/").filter(Boolean);
  if (segments[0] !== "novel") return false;
  return segments.length === 2 || (segments.length === 4 && segments[2] === "chapter");
}

/** 菜单条目的 `href`：直接切换用换前缀的路径，其余一律是目标语种首页（真正的跳转由点击处理接管）。 */
function hrefForMenuItem(pathname: string, target: SiteLocale): string {
  return planLocaleSwitch(pathname).kind === "direct"
    ? buildLocaleSwitchHref(pathname, target)
    : buildLocaleHomeHref(target);
}

function writeLocaleCookie(target: SiteLocale): void {
  try {
    document.cookie = `${COOKIE_NAME_NEXT_LOCALE}=${target}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
  } catch {
    // Cookie 被禁用不影响切换本身。
  }
}

function stashSwitchToast(message: string): void {
  try {
    window.sessionStorage.setItem(
      TOAST_STORAGE_KEY,
      JSON.stringify({ message, expiresAt: Date.now() + TOAST_DURATION_MS }),
    );
  } catch {
    // 存储不可用（隐私模式等）：少一条跨页提示，不影响跳转。
  }
}

/** 读回上一页留下的提示；过期、缺失、格式不对一律当没有。不删除——3.5 秒到期后自然失效，读回不是"消费"。 */
function readStashedSwitchToast(): { message: string; remainingMs: number } | null {
  try {
    const raw = window.sessionStorage.getItem(TOAST_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { message, expiresAt } = parsed as { message?: unknown; expiresAt?: unknown };
    if (typeof message !== "string" || !message || typeof expiresAt !== "number") return null;
    const remainingMs = expiresAt - Date.now();
    return remainingMs > 0 ? { message, remainingMs } : null;
  } catch {
    return null;
  }
}

async function lookupNovelSibling(slugParam: string, target: SiteLocale): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(
      `/api/novel-locale-check?slug=${encodeURIComponent(slugParam)}&target=${encodeURIComponent(target)}`,
      { signal: controller.signal },
    );
    if (!response.ok) throw new Error(`novel-locale-check responded ${response.status}`);
    const data = (await response.json()) as { hasMatch?: boolean; path?: string };
    return data.hasMatch && typeof data.path === "string" && data.path ? data.path : null;
  } finally {
    clearTimeout(timer);
  }
}

/** 展示形态。逻辑一律共用，只有外观与挂载位置不同，见文件头最后一段。 */
export type LocaleSwitcherVariant = "pill" | "menuRow";

export function LocaleSwitcher({
  activeLocales = [],
  variant = "pill",
  onNavigate,
}: {
  activeLocales?: readonly SiteLocale[];
  variant?: LocaleSwitcherVariant;
  /**
   * 点了某个语种条目、真的要切换语种时调用（点当前语种、带修饰键的点击不算）。
   * 手机菜单借它在跳转时把整块面板收起来；胶囊形态不需要。
   */
  onNavigate?: () => void;
}) {
  // Deliberately decided BEFORE any hook that needs App Router context runs (see the
  // file-level comment on why: `usePathname()` needs real App Router context, which existing
  // tests that render `SiteHeader`/`SiteShell` do not provide — and don't need to, since
  // callers that don't care about the switcher pass no `activeLocales` prop, defaulting to
  // `[]`). `useOptionalLocale()` is a plain `useContext` that returns `null` without a
  // provider, so calling it first neither needs that context nor breaks the rules of hooks:
  // the early return below does not change between renders of the same mounted instance
  // (both inputs are stable for the component's whole lifetime).
  const currentLocale = useOptionalLocale();
  if (activeLocales.length === 0) return null;
  // PN-09：菜单条目 = activeLocales ∪ {当前语种} ∪ {en}（见文件头）。用户直接打开了空语种
  // （如 /cs）而全站只有英文有书时，activeLocales 只有 ["en"]——此时仍要显示菜单
  // （[English, 当前语种]），否则这位读者连回英文的入口都没有。当前语种本身就在集合里、
  // 或没有 provider（取不到当前语种）时，沿用原规则：集合不足两项就不渲染。
  const distinct = new Set<SiteLocale>(activeLocales);
  if (currentLocale) distinct.add(currentLocale);
  if (distinct.size <= 1) return null;
  return <LocaleSwitcherMenu selectable={activeLocales} variant={variant} onNavigate={onNavigate} />;
}

function LocaleSwitcherMenu({
  selectable,
  variant,
  onNavigate,
}: {
  selectable: readonly SiteLocale[];
  variant: LocaleSwitcherVariant;
  onNavigate?: () => void;
}) {
  const isRow = variant === "menuRow";
  const t = useT();
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const switchInFlightRef = useRef(false);
  const [isOpen, setIsOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState("");

  // 菜单条目：动态层给的集合 ∪ 当前语种 ∪ en，按 SITE_LOCALES 登记顺序。
  const menuItems = SITE_LOCALES.filter(
    (item) => item === PUBLIC_SITE_LOCALE || item === locale || selectable.includes(item),
  );

  function showToast(message: string, durationMs: number = TOAST_DURATION_MS) {
    setToastMessage(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMessage(""), durationMs);
  }

  // 挂载时读回上一页（切换前的页面）留下的提示——见文件头第 1 条说明。
  // 值只存在于客户端 sessionStorage，渲染期读会破坏水合（服务端不可能知道），
  // 所以只能挂载后同步一次——与 `ReaderSettingsProvider` 从 localStorage 读初值
  // 是同一种 `react-hooks/set-state-in-effect` 覆盖不到的正当情形。
  useEffect(() => {
    // 手机菜单里的语种行不读回：上一页的提示由始终挂载的胶囊实例显示，两边都读会显示两遍。
    if (isRow) return;
    const stashed = readStashedSwitchToast();
    if (stashed) {
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setToastMessage(stashed.message);
      toastTimerRef.current = setTimeout(() => setToastMessage(""), stashed.remainingMs);
    }
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [isRow]);

  useEffect(() => {
    // 手机菜单里的语种行是就地展开的列表：不做「点外面收起」，Esc 由行自己的 onKeyDown 处理（见下）。
    if (!isOpen || isRow) return;

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, isRow]);

  /** 目标语种没有对应内容：弹提示（同时留给下一页），再回目标语种首页。 */
  function fallBackToHome(target: SiteLocale, search: string) {
    const key = isBookPagePath(pathname ?? "/") ? "localeSwitcher.fallbackToast" : "localeSwitcher.fallbackToastPage";
    const message = t(key, { locale: SITE_LOCALE_NATIVE_NAMES[target] });
    stashSwitchToast(message);
    showToast(message);
    router.push(buildLocaleHomeHref(target, search));
  }

  /**
   * 点击菜单条目（CPS `switchLocale` 的对应物）。
   *
   * `window.location.search` is deliberately NOT read in the render body —
   * CPS's own switcher never touches `location` synchronously during render
   * either, only inside its click handler. Reading it during render would
   * also be a real hydration bug: `window` is undefined during the server
   * render (so the SSR'd `href`s never carry a query string), but defined on
   * the very first CLIENT render of this "use client" component, so any real
   * query string would make that first client render's `href`s disagree with
   * what the server sent — a genuine markup mismatch. It is read here, at
   * click time, when there is no server/client value to disagree with.
   */
  async function handleSwitchClick(event: ReactMouseEvent<HTMLAnchorElement>, target: SiteLocale) {
    setIsOpen(false);
    // Let the browser handle its own default gesture (open in new tab/
    // window, "save link as", etc.) untouched — only a plain, unmodified
    // left click is taken over below.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    // CPS：点当前语种什么都不做；上一次切换还没落地时也不重复发起。
    if (target === locale || switchInFlightRef.current) {
      event.preventDefault();
      return;
    }

    writeLocaleCookie(target);
    onNavigate?.();
    const search = window.location.search;
    const plan = planLocaleSwitch(pathname ?? "/", search);

    if (plan.kind === "direct") {
      // 非搜索页 `carried === search`（与此前一致）；搜索页只带 q，page 不带。
      if (!localeSwitchSearch(pathname ?? "/", search)) return; // the rendered href is already correct with no query string
      event.preventDefault();
      router.push(buildDirectLocaleSwitchHref(pathname ?? "/", target, search));
      return;
    }

    event.preventDefault();

    if (plan.kind === "fallback") {
      fallBackToHome(target, search);
      return;
    }

    switchInFlightRef.current = true;
    try {
      const siblingPath = await lookupNovelSibling(plan.slugParam, target);
      if (siblingPath) {
        router.push(buildLocaleSwitchHref(siblingPath, target, search));
      } else {
        fallBackToHome(target, search);
      }
    } catch {
      fallBackToHome(target, search);
    } finally {
      switchInFlightRef.current = false;
    }
  }

  const items = menuItems.map((item) => {
    const isCurrent = item === locale;
    return (
      <Link
        key={item}
        role="menuitem"
        aria-current={isCurrent ? "true" : undefined}
        href={hrefForMenuItem(pathname ?? "/", item)}
        onClick={(event) => void handleSwitchClick(event, item)}
        className={
          isRow
            ? `flex min-h-11 w-full items-center rounded-novel-sm px-3 text-start text-[15px] transition-colors ${
                isCurrent
                  ? "bg-novel-bg-raised text-novel-primary"
                  : "text-novel-fg-muted hover:bg-novel-bg-raised hover:text-novel-fg"
              }`
            : `block w-full rounded-novel-sm px-3 py-2 text-start text-sm transition-colors ${
                isCurrent
                  ? "bg-novel-bg text-novel-primary"
                  : "text-novel-fg-muted hover:bg-novel-bg hover:text-novel-fg"
              }`
        }
      >
        {SITE_LOCALE_NATIVE_NAMES[item]}
      </Link>
    );
  });

  if (isRow) {
    return (
      <div
        ref={rootRef}
        className="w-full"
        onKeyDown={(event) => {
          // 只收起这一行自己的列表，并且不让事件冒到 document 上的页头 Esc 处理（它会把整块面板关掉）
          if (event.key === "Escape" && isOpen) {
            event.stopPropagation();
            setIsOpen(false);
            triggerRef.current?.focus();
          }
        }}
      >
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={isOpen}
          aria-controls={menuId}
          onClick={() => setIsOpen((open) => !open)}
          className="flex min-h-[52px] w-full items-center justify-between gap-3 text-start text-[15px] text-novel-fg-muted transition-colors hover:text-novel-fg"
        >
          <span className="inline-flex items-center gap-2.5">
            <GlobeIcon />
            <span>{t("nav.language")}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-novel-fg">
            <span>{SITE_LOCALE_NATIVE_NAMES[locale]}</span>
            <ChevronIcon open={isOpen} size={14} />
          </span>
        </button>

        {isOpen ? (
          <div
            id={menuId}
            role="menu"
            aria-orientation="vertical"
            className="flex flex-col gap-0.5 pb-3 ps-7"
          >
            {items}
          </div>
        ) : null}

        {toastMessage ? (
          <div
            role="status"
            className="mb-3 rounded-novel-md border border-novel-border bg-novel-bg-raised px-3 py-2 text-xs text-novel-fg"
          >
            {toastMessage}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    // 手机上根节点不生成盒子（`contents`），它的子节点里只有提示条会显示，且是 `fixed`——
    // 不占页头的 flex 位置、不多出一道 gap。`md` 起恢复成原来的 `relative inline-flex`。
    // `md:ms-2`：与前面的导航之间 8px 额外间距（设计稿 margin-right: 8px），挂在胶囊自己身上，
    // 这样语种入口不渲染时导航不会白白少 8px。
    <div ref={rootRef} className="contents md:relative md:ms-2 md:inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("nav.language")}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        onClick={() => setIsOpen((open) => !open)}
        className="hidden items-center gap-1.5 rounded-novel-md border border-novel-border-strong bg-transparent px-3 py-1.5 text-sm text-novel-fg-muted transition-colors hover:bg-novel-bg-raised hover:text-novel-fg md:inline-flex"
      >
        <span>{SITE_LOCALE_NATIVE_NAMES[locale]}</span>
        <ChevronIcon open={isOpen} size={12} />
      </button>

      {/* 🔴 下拉面板与提示条用逻辑属性 end-0 贴触发器的「末端」：从右到左时触发器在
          页头左侧，物理的 right-0 会让面板向左伸出视口。
          层级 z-60 高于阅读设置面板（z-50，PN-03）：两者都不建立层叠上下文、同处根层叠
          上下文，同为 z-50 时 DOM 靠后的面板会盖住页头里的菜单（桌面端两者可同时打开）。
          面板对续读条（z-40）的优先级不变。 */}
      {isOpen ? (
        <div
          id={menuId}
          role="menu"
          aria-orientation="vertical"
          className="absolute end-0 top-full z-60 mt-2 min-w-[10rem] rounded-novel-md border border-novel-border bg-novel-bg-raised p-1 shadow-lg"
        >
          {items}
        </div>
      ) : null}

      {/* 提示条：手机上触发按钮不显示，所以改成 fixed 贴在页头（h-16）下沿、距视口末端 1rem；
          md 起回到原来的 absolute 挂在触发按钮下面。`end-0` + `mx-4` 在手机上等价于「离末端 1rem」，
          md 把外边距清零。 */}
      {toastMessage ? (
        <div
          role="status"
          className="fixed end-0 top-[4.5rem] z-60 mx-4 w-64 max-w-[calc(100vw-2rem)] rounded-novel-md border border-novel-border bg-novel-bg-raised px-3 py-2 text-xs text-novel-fg shadow-lg md:absolute md:top-full md:mx-0 md:mt-2 md:max-w-none"
        >
          {toastMessage}
        </div>
      ) : null}
    </div>
  );
}

function ChevronIcon({ open, size }: { open: boolean; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className={`transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path d="M5 7.5l5 5 5-5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M2.75 10h14.5M10 2.75c2 2.1 3 4.5 3 7.25s-1 5.15-3 7.25M10 2.75c-2 2.1-3 4.5-3 7.25s1 5.15 3 7.25"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}
