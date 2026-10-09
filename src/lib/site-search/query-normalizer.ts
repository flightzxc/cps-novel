// 站内搜索查询归一（PN-15）。管线顺序不可调整，每一步都在为下一步的正确性铺垫。
//
// 移植自 CPS v8.7.2 `src/lib/site-search/query-normalizer.ts` 的 `normalizeSearchInput`，
// **删掉 `buildCaseVariants`**——那是为 SQLite 的 LIKE 只对 ASCII 不分大小写造的兼容层，
// PostgreSQL 在数据库里 `lower()` 折叠，不需要（方案第三节"大小写"一行）。
// 绝不 import 会折叠标点的"名称归一"类函数：它会让 "Love, Actually" 这类真实书名搜不到。

import {
  SITE_SEARCH_CJK_SINGLE_CHAR_LANGS,
  SITE_SEARCH_MAX_QUERY_LENGTH,
  SITE_SEARCH_MIN_QUERY_LENGTH,
  type NormalizedSearchQuery,
} from "./types";

/** Unicode 码点计数（不是 UTF-16 `.length`）：emoji 等代理对按 1 个算。 */
export function countCodePoints(value: string): number {
  return [...value].length;
}

// 不可见/格式类码点：ZWSP(U+200B)、LRM/RLM(U+200E/200F)、BOM(U+FEFF) 等 Cf，非空白的 Cc，孤立代理项。
// JS 正则 \s 不匹配 Cf/Cc/Cs，必须单独剔除。
const INVISIBLE_CODEPOINTS_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
const WHITESPACE_PATTERN = /\s/gu;
const SPACE_RUN_PATTERN = / +/g;
// 判定"是否只剩通配符"：剥离 % 和 _ 之后看是否还有字面字符。
const WILDCARD_ONLY_PATTERN = /[%_]/g;

// v8.1.1 CJK 单字放行：只认 Han（含扩展 B 等增补平面，如 𠮷）、Hiragana、Katakana、Hangul 四个 Script。
// 锚定 + 单字符，不用 \p{L} 等宽泛类目，避免标点、假名长音符 ー(U+30FC, Script=Common)、
// 拉丁字母、西里尔字母等被误放行；"u" 旗标让 \p{Script=...} 按码点匹配，增补平面字符才落在"单字符"里。
const CJK_SINGLE_CHAR_PATTERN =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;

/** 语种是否允许单字符查询过长度门槛。只看 BCP-47 语言子标签（连字符前半段）：zh-Hant 与裸 zh 同等对待。 */
export function allowsCjkSingleCharacter(locale: string | undefined): boolean {
  if (!locale) return false;
  const lang = locale.split("-")[0]!.toLowerCase();
  return (SITE_SEARCH_CJK_SINGLE_CHAR_LANGS as readonly string[]).includes(lang);
}

export function normalizeSearchInput(raw: unknown, locale?: string): NormalizedSearchQuery {
  // 0. 取值：数组取第一个元素（重复 query 参数），非字符串一律当空处理。
  const rawValue = Array.isArray(raw) ? raw[0] : raw;
  const input = typeof rawValue === "string" ? rawValue : "";

  // 1. NFKC 必须最先做：它会改变字符串长度（全角→半角、① → 1、ﬁ → fi），后续的码点长度门槛必须作用在
  //    最终形态上，否则门槛判定会和读者看到的字符数不一致。
  let value = input.normalize("NFKC");

  // 2. 先把所有空白类字符统一成普通空格（\s 覆盖 \n \r \t、NBSP、全角空格、U+2028/2029）。
  //    必须在剔除控制字符之前：换行与制表符属于 Cc，若先剔除，跨行的词会被粘成一个。
  value = value.replace(WHITESPACE_PATTERN, " ");

  // 3. 剔除剩下的不可见/格式类码点。零宽字符按其"零宽"语义直接删除，而不是折成空格。
  value = value.replace(INVISIBLE_CODEPOINTS_PATTERN, "");

  // 4. 折叠连续空格（第 3 步删掉夹在空格之间的零宽字符后可能留下双空格）并去掉收尾空白。
  value = value.replace(SPACE_RUN_PATTERN, " ").trim();

  // 5. 码点门槛。
  const codePointCount = countCodePoints(value);
  if (codePointCount === 0) {
    return { ok: false, reason: "idle", displayQuery: value };
  }
  if (codePointCount < SITE_SEARCH_MIN_QUERY_LENGTH) {
    // zh/ja/ko 下恰好 1 个 Han/Hiragana/Katakana/Hangul 码点已经能表达完整检索意图（「愛」「사」），放行。
    // NFKC 已在第 1 步把半角假名归一（ｱ → ア），这里测的是最终形态。
    const isSingleCjkChar =
      codePointCount === 1 && allowsCjkSingleCharacter(locale) && CJK_SINGLE_CHAR_PATTERN.test(value);
    if (!isSingleCjkChar) {
      return { ok: false, reason: "too_short", displayQuery: value };
    }
  }
  if (codePointCount > SITE_SEARCH_MAX_QUERY_LENGTH) {
    return { ok: false, reason: "too_long", displayQuery: value };
  }

  // 6. 字面性检查：去掉所有 % 和 _ 后如果没有剩余字面字符，说明这是纯通配符查询（"%%"、"__"），按过短处理
  //    （照 CPS；海阅在数据库里转义，送进去也只是字面匹配，但这类输入没有检索意图，口径与 CPS 一致）。
  if (value.replace(WILDCARD_ONLY_PATTERN, "").trim().length === 0) {
    return { ok: false, reason: "too_short", displayQuery: value };
  }

  // 7. 搜索词原样保留 % _ \ 等字符——绝不剥离。真实书名里可能出现字面 "%"（"100% Sweet"）；
  //    转义（先归一再转义，全角 "％" 归一后才变成 "%"）在数据库里做，见 `search-query.ts`。
  return { ok: true, query: value, displayQuery: value };
}
