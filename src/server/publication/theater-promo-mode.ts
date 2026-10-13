/**
 * 剧场推广模式（v0.6.0，接入畅读 PlotNovel 剧场）——唯一真源。
 *
 * 一个剧场（`channel_app`）怎么给读者"去阅读"的入口，由 `channel_app.config`（JSONB）里的几个键决定，
 * **不新增迁移、不新增环境变量**：
 *
 *   - `promoMode`      `"link"`（默认）或 `"code"`。缺省、拼错、不是字符串，一律按 `"link"`——旧记录
 *                      （MoboReader 登记时 `config = {}`）零改动继续按链接模式工作。
 *   - `agencyIds`      上游目录里这个剧场对应的机构编号（字符串数组）。目录扫描按它把每本书落到所属剧场。
 *   - `codeModeLocales` 口令码模式下"哪些语种的书算就绪"。只在 `promoMode = "code"` 时有意义。
 *   - `appDisplayName` / `appStoreUrl` / `googlePlayUrl`  中间页展示用的 App 名与下载链接，所有书共用。
 *
 * 为什么"有没有网址"不再能单独决定就绪：PlotNovel 的书上游只给口令码（读者要下载 App 再搜口令），
 * 没有任何网址。就绪规则因此按剧场模式二选一，两种模式**互不相交**（见 `visibility.ts` 的
 * `isPromoReady` 与 SQL 对应物 `promoReadySql`）：
 *
 *   - link 模式：`status = fetched` 且 web/app 网址至少一个非空（规则逐字不变）；
 *   - code 模式：`status = fetched` 且 `upstream_code` 非空、且书的语种在 `codeModeLocales` 里。
 *
 * 本文件只做"解析 + 判定"，不读库、不依赖 Prisma——worker、脚本、Web 都能引用。
 */
import { DEFAULT_CODE_MODE_APP_NAME } from "../../lib/locale/code-mode-copy";

export const THEATER_PROMO_MODES = ["link", "code"] as const;
export type TheaterPromoMode = (typeof THEATER_PROMO_MODES)[number];

/** 配置里写入的键名，脚本、字典、测试共用，避免各处各写一遍字符串。 */
export const THEATER_CONFIG_KEYS = Object.freeze({
  promoMode: "promoMode",
  agencyIds: "agencyIds",
  codeModeLocales: "codeModeLocales",
  appDisplayName: "appDisplayName",
  appStoreUrl: "appStoreUrl",
  googlePlayUrl: "googlePlayUrl",
} as const);

export type TheaterPromoConfig = Readonly<{
  promoMode: TheaterPromoMode;
  agencyIds: readonly string[];
  codeModeLocales: readonly string[];
  appDisplayName: string | null;
  appStoreUrl: string | null;
  googlePlayUrl: string | null;
}>;

const MAX_LIST_ITEMS = 64;
const MAX_ITEM_LENGTH = 128;
const MAX_URL_LENGTH = 2048;
const MAX_DISPLAY_NAME_LENGTH = 80;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, MAX_LIST_ITEMS)) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_ITEM_LENGTH) continue;
    seen.add(trimmed);
  }
  return Object.freeze([...seen]);
}

/**
 * 商店链接只认 `https:` 且能被 WHATWG URL 解析的绝对地址；其它（`javascript:`、`data:`、`http:`、
 * 相对路径、空串）一律当作"没配"。配置是运营经脚本写进库的，这一道是渲染前的最后防线——页面上
 * 的 `<a href>` 绝不会因为配置写错而变成可执行脚本。
 */
export function normalizeStoreUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function displayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DISPLAY_NAME_LENGTH) return null;
  return trimmed;
}

/**
 * 把 `channel_app.config` 解析成强类型。永远不抛：任何不认识的形状都退回 link 模式的默认值，
 * 因为"认不出来"时唯一安全的方向是维持改动前的行为（要求有网址）。
 */
export function parseTheaterPromoConfig(config: unknown): TheaterPromoConfig {
  const source = isPlainObject(config) ? config : {};
  return Object.freeze({
    promoMode: source[THEATER_CONFIG_KEYS.promoMode] === "code" ? "code" : "link",
    agencyIds: stringList(source[THEATER_CONFIG_KEYS.agencyIds]),
    codeModeLocales: stringList(source[THEATER_CONFIG_KEYS.codeModeLocales]),
    appDisplayName: displayName(source[THEATER_CONFIG_KEYS.appDisplayName]),
    appStoreUrl: normalizeStoreUrl(source[THEATER_CONFIG_KEYS.appStoreUrl]),
    googlePlayUrl: normalizeStoreUrl(source[THEATER_CONFIG_KEYS.googlePlayUrl]),
  });
}

export function isCodeModeTheater(config: unknown): boolean {
  return parseTheaterPromoConfig(config).promoMode === "code";
}

/**
 * 口令码模式的就绪判定（纯函数）。调用方负责先判 `status === "fetched"`——本函数只回答
 * "这个剧场的这本书，口令码够不够用"。
 *
 * `upstreamCode` 的"非空"口径与链接模式的网址完全一致：按 ECMAScript `String.prototype.trim` 修剪后
 * 长度大于 0（SQL 对应物用同一套字符集，见 `promoReadySql`）。
 */
export function isCodeModeBookReady(input: {
  readonly config: unknown;
  readonly upstreamCode: string | null | undefined;
  readonly novelLocale: string | null | undefined;
}): boolean {
  const theater = parseTheaterPromoConfig(input.config);
  if (theater.promoMode !== "code") return false;
  if (input.upstreamCode == null || input.upstreamCode.trim().length === 0) return false;
  if (input.novelLocale == null || input.novelLocale.length === 0) return false;
  return theater.codeModeLocales.includes(input.novelLocale);
}

/**
 * 中间页（`/go/<站内码>/app`）与书页按钮给读者看的 App 名：配置里没写就用 "PlotNovel"。
 * 不在这里做多语言——口令码模式目前只对英语书开放（见 ADR-V060 的已知限制，文案在 `code-mode-copy.ts`）。
 */
export { DEFAULT_CODE_MODE_APP_NAME };

export function codeModeAppName(config: TheaterPromoConfig): string {
  return config.appDisplayName ?? DEFAULT_CODE_MODE_APP_NAME;
}
