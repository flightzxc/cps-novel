import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { describe, expect, it } from "vitest";

import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { CATALOGS, loadMessages, t, type MessageKey } from "@/lib/locale/messages";
import { en } from "@/lib/locale/messages/en";

/**
 * Completeness gate for the 15 registered-locale message catalogs (工单三
 * §10.3, Owner 修正一；ICU plural support added by
 * 施工工单_I18N_复数能力_移植CPS_next-intl_plural_2026-09-10.md 步骤 4).
 *
 * `loadMessages` deep-merges every locale onto English at *runtime* and
 * never throws — a missing or blank translation quietly renders the
 * English text instead (`src/lib/locale/messages/index.ts`). That is
 * exactly why this file exists: nothing in the render path will ever flag
 * a translation gap, so completeness has to be enforced here, at test
 * time, against the **raw** per-locale catalogs (`CATALOGS`, pre-merge) —
 * checking the merged/fallback result would just see English everywhere
 * and could never catch a missing key, an empty string, a mismatched
 * interpolation variable, or a banned ICU form.
 *
 * 短剧站的教训（工单三 §10.3 引用）：CPS 有深合并回落，但没有一条覆盖全目录
 * 的完整性测试——只有五个局部命名空间守卫，回落把缺口悄悄补成英文，没有任何
 * 测试注意到十五套目录里平均每套躺着 20.6 条未翻译的英文原文。这份文件就是
 * 补上那半个机制：回落在运行时、完整性在 CI，两半缺一不可。
 *
 * 步骤 4（本次改动）把两条曾经的正则检查换成走 AST 的检查（正则看不见 ICU
 * `plural` 语法内部的参数名和类别），并新增第三条：带 plural 的键在每个语种
 * 必须恰好覆盖该语种的全部 CLDR 复数类别，不多不少。
 */

type LeafPath = string;

function flattenLeaves(node: unknown, prefix: LeafPath[] = []): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (node !== null && typeof node === "object" && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      for (const [path, leaf] of flattenLeaves(value, [...prefix, key])) {
        out.set(path, leaf);
      }
    }
    return out;
  }
  out.set(prefix.join("."), node);
  return out;
}

const EN_LEAVES = flattenLeaves(en);
const EN_KEYS = new Set(EN_LEAVES.keys());

function interpolationVars(value: string): Set<string> {
  return new Set(Array.from(value.matchAll(/\{([a-zA-Z0-9_]+)\}/g), (m) => m[1]));
}

/**
 * 低危清扫第 1 批 · item D-②: the leftover-English check used to compare
 * `localeValue !== enValue` byte-for-byte. Two values that only differ by
 * incidental whitespace (a trailing space, a doubled interior space) or by
 * case are still the same untranslated English sentence — byte equality let
 * those slip past undetected while genuinely translated text that happens
 * to share a value with English (the `ALLOW_SAME_AS_EN`/`_SCOPED`
 * allowlists below) was never at risk of a false positive either way, so
 * relaxing the comparison only ever *tightens* the check, never loosens it.
 */
function normalizeForResidueComparison(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * AST inspection of a single catalog value (施工工单_I18N_复数能力 §5 / 附录
 * D). Replaces the pre-step-4 regex-based `ICU_SYNTAX_RE` ban and
 * `interpolationVars` placeholder scan — a regex can't see inside
 * `{count, plural, ...}` (it isn't shaped like a bare `{name}`), so it
 * would either (a) reject every `plural` message outright (the old
 * behavior, now wrong now that catalogs legitimately use `plural`) or (b)
 * if merely disabled, go blind to argument names and category coverage
 * living inside plural branches. Walking the real parsed AST sees both.
 *
 * `parse()` throws on invalid ICU syntax (a missing `other` clause, a
 * dangling brace, ...) — that failure is surfaced as `parseError` rather
 * than propagating, so callers can report it as a normal assertion failure
 * instead of crashing the whole test file.
 */
type PluralInfo = { name: string; categories: string[]; exact: string[] };
type InspectResult =
  | { parseError: string }
  | { args: Set<string>; plurals: PluralInfo[]; banned: string[] };

/**
 * ICU node types this gate allows to appear anywhere in a catalog value.
 * Everything else (select/selectordinal/number/date/time/tag) is banned —
 * see the `banned` collection below.
 *
 * `TYPE.pound` (the bare `#` element, ICU shorthand for "substitute the
 * plural's own number here") is deliberately *not* in this set — Owner
 * 拍板 2026-09-10: every plural branch must spell out `{count}` instead of
 * `#`, so the catalog stays greppable/diffable by argument name and every
 * branch's number formatting goes through the one documented path
 * (`{count}` substitution), not a second implicit one. `walk()` below still
 * recurses into a plural node's branches (`for (const option of
 * Object.values(node.options)) walk(option.value)`), so a `#` living inside
 * a branch reaches this same allow/ban check like any other node — the
 * generic `if (!ALLOWED_TYPES.has(node.type))` branch below catches it and
 * reports it as `"pound"` (via `TYPE_NAME`), exactly like any other banned
 * ICU form. No separate pound-specific check was needed.
 */
const ALLOWED_TYPES: ReadonlySet<TYPE> = new Set([TYPE.literal, TYPE.argument, TYPE.plural]);
const TYPE_NAME: Readonly<Record<number, string>> = {
  [TYPE.literal]: "literal",
  [TYPE.argument]: "argument",
  [TYPE.number]: "number",
  [TYPE.date]: "date",
  [TYPE.time]: "time",
  [TYPE.select]: "select",
  [TYPE.plural]: "plural",
  [TYPE.pound]: "pound",
  [TYPE.tag]: "tag",
};

function inspect(message: string): InspectResult {
  const args = new Set<string>();
  const plurals: PluralInfo[] = [];
  const banned: string[] = [];
  let ast: MessageFormatElement[];
  try {
    ast = parse(message);
  } catch (error) {
    return { parseError: error instanceof Error ? error.message : String(error) };
  }
  const walk = (nodes: MessageFormatElement[]) => {
    for (const node of nodes) {
      if (!ALLOWED_TYPES.has(node.type)) {
        banned.push(TYPE_NAME[node.type] ?? String(node.type));
        continue;
      }
      if (node.type === TYPE.argument) args.add(node.value);
      if (node.type === TYPE.plural) {
        // `pluralType` is `"cardinal"` for `plural` and `"ordinal"` for
        // `selectordinal` — the parser accepts both under the same node
        // type, so `selectordinal` has to be caught here, not by `TYPE`.
        if (node.pluralType !== "cardinal") {
          banned.push("selectordinal");
          continue;
        }
        args.add(node.value);
        const keys = Object.keys(node.options);
        plurals.push({
          name: node.value,
          categories: keys.filter((k) => !k.startsWith("=")),
          exact: keys.filter((k) => k.startsWith("=")),
        });
        for (const option of Object.values(node.options)) walk(option.value);
      }
    }
  };
  walk(ast);
  return { args, plurals, banned };
}

/**
 * Signed-in expectation table for §5.1 第三条 (施工工单_I18N_复数能力):
 * `Intl.PluralRules(locale).resolvedOptions().pluralCategories` is CLDR
 * data baked into the JS engine's ICU build, and CLDR revises category
 * sets over time (`many` was added to fr/es/pt-BR in CLDR 42). If the
 * CLDR-coverage test below read `Intl.PluralRules` directly, a Node/ICU
 * upgrade could silently change what "complete" means and turn every
 * locale's plural keys red at once — with a diff that *looks* like 15
 * translations went stale, when the actual cause is the runtime.
 *
 * Freezing the expectation here decouples the two failure modes: the
 * catalog-coverage test below always compares against this table (stable
 * across ICU versions), while a *separate* test checks the runtime's own
 * `Intl.PluralRules` against this exact table — so an ICU upgrade that
 * actually changes a locale's category set shows up as "this table needs
 * an Owner-reviewed update," not as a wall of unrelated translation
 * failures. Values are sorted alphabetically (not spec order) because the
 * order `resolvedOptions().pluralCategories` returns is not itself part of
 * the ECMA-402 contract — verified empirically: Node 24.12.0 (ICU 77.1,
 * this repo's primary dev environment) and Node 20.20.2 (ICU 78.3, pinned
 * by `.nvmrc`/`engines` and the version CI runs) return the *same set* of
 * categories for all 15 locales but in a *different order* for every
 * locale with 3+ categories (ar/cs/es/fr/pl/pt-BR/ru) — an order-sensitive
 * comparison would have failed on one Node version or the other for
 * reasons that have nothing to do with translation content.
 */
const EXPECTED_PLURAL_CATEGORIES: Readonly<Record<SiteLocale, readonly string[]>> = {
  en: ["one", "other"],
  es: ["many", "one", "other"],
  "pt-BR": ["many", "one", "other"],
  id: ["other"],
  vi: ["other"],
  th: ["other"],
  ja: ["other"],
  ko: ["other"],
  "zh-Hant": ["other"],
  ar: ["few", "many", "one", "other", "two", "zero"],
  fr: ["many", "one", "other"],
  de: ["one", "other"],
  pl: ["few", "many", "one", "other"],
  cs: ["few", "many", "one", "other"],
  ru: ["few", "many", "one", "other"],
};

/**
 * Keys where the translated value is *allowed* to be byte-identical to the
 * English value — an exhaustive, justified allowlist, not a place to hide
 * an unreviewed translation gap. Every entry needs a reason:
 *
 *  - `blog.listTitle` ("Blog"): deliberately unchanged in all 15 locales —
 *    same call CPS made for its own `blog.title` (工单三 §10.3 item 6).
 *  - `pagination.pageOf` ("{current} / {total}"): a locale-agnostic digit
 *    ratio, not prose — CPS's `common.pageOf` is identical across all 15
 *    of its locales for the same reason.
 *  - `nav.genres` ("Genres") in `fr`: the correct French word — French is
 *    the etymological source of the English word, not a leftover.
 *  - `pagination.label` ("Pagination") in `fr`: same — French is the
 *    etymological source of the English word.
 */
const ALLOW_SAME_AS_EN: ReadonlySet<string> = new Set(["blog.listTitle", "pagination.pageOf"]);
const ALLOW_SAME_AS_EN_SCOPED: ReadonlySet<string> = new Set(["fr:nav.genres", "fr:pagination.label"]);

const NON_EN_LOCALES = SITE_LOCALES.filter((locale) => locale !== "en");

/**
 * Sentence-count parity gate (施工报告_公开页description与句数门禁_2026-09-10
 * 任务 2). Motivation: a prior sentence-trimming pass removed one sentence
 * too many from a single locale's translation with nothing to catch it —
 * `loadMessages`'s runtime fallback (see this file's own header comment)
 * only guards against a *missing* key, not a key that is present but says
 * less than the English original.
 *
 * Sentence-terminator character sets, grouped by script convention rather
 * than per-locale (fewer places to keep in sync, and every locale in a
 * group genuinely shares the convention):
 *  - Latin/Cyrillic (en, es, pt-BR, id, vi, ko, fr, de, pl, cs, ru): `. ! ? …`
 *  - ja / zh-Hant: fullwidth `。！？…`, and — because both catalogs mix in
 *    halfwidth ASCII punctuation for embedded Latin terms/numbers — the
 *    halfwidth `. ! ? …` forms are accepted too.
 *  - ar: `. ! ؟ …` (Arabic question mark `؟`, not `?`; period/exclamation/
 *    ellipsis are the same characters as Latin).
 *  - th: EXEMPT — Thai prose has no sentence-final punctuation convention
 *    (no obligatory period at a sentence boundary), so a terminator count
 *    would not measure sentences at all. Registered explicitly via
 *    `SENTENCE_COUNT_LOCALES` below, not silently skipped.
 */
type SentenceGroup = "latin-cyrillic" | "cjk-fullwidth" | "arabic" | "exempt";

function sentenceGroupFor(locale: SiteLocale): SentenceGroup {
  if (locale === "th") return "exempt";
  if (locale === "ja" || locale === "zh-Hant") return "cjk-fullwidth";
  if (locale === "ar") return "arabic";
  return "latin-cyrillic";
}

const TERMINATOR_CHARS: Readonly<Record<Exclude<SentenceGroup, "exempt">, ReadonlySet<string>>> = {
  "latin-cyrillic": new Set([".", "!", "?", "…"]),
  "cjk-fullwidth": new Set(["。", "！", "？", "…", ".", "!", "?"]),
  arabic: new Set([".", "!", "؟", "…"]),
};

/**
 * Minimal-rule sentence counter. Two disambiguation rules, both named in
 * the work order and nothing beyond them (no abbreviation dictionary —
 * "e.g."/"Mr."-style lists are out of scope by the spec's own "最小规则"
 * instruction, and none of the 15 catalogs' actual leaf values need one
 * today — verified by inspection, see the construction report):
 *
 *  - a run of consecutive terminator characters counts as ONE boundary
 *    (handles "?!"  and the three-ASCII-period spelling of an ellipsis,
 *    "...", identically to a single "…");
 *  - a "." with a digit on both sides (a decimal point, e.g. "3.5") is
 *    never a boundary.
 *
 * Returns `-1` for an exempt locale (`th`) — callers must check for that
 * sentinel rather than comparing it as a real count.
 */
function countSentences(text: string, locale: SiteLocale): number {
  const group = sentenceGroupFor(locale);
  if (group === "exempt") return -1;
  const terminators = TERMINATOR_CHARS[group];
  const chars = Array.from(text);
  let count = 0;
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (!terminators.has(ch)) {
      i++;
      continue;
    }
    const isDecimalPoint =
      ch === "." &&
      i > 0 &&
      i < chars.length - 1 &&
      /[0-9]/.test(chars[i - 1]) &&
      /[0-9]/.test(chars[i + 1]);
    if (isDecimalPoint) {
      i++;
      continue;
    }
    count++;
    let j = i + 1;
    while (j < chars.length && terminators.has(chars[j])) j++;
    i = j;
  }
  return count;
}

/**
 * `th` is excluded up front (see `sentenceGroupFor`'s doc comment) — this
 * is the "显式登记" the work order asks for, not a silent filter.
 */
const SENTENCE_COUNT_LOCALES = NON_EN_LOCALES.filter((locale) => locale !== "th");

/**
 * Pre-existing, reviewed sentence-count divergences from English — "登记，
 * 不改译文" (任务 2 point 2). Each entry needs a reason; this is not a place
 * to silently swallow a real translation gap. Scoped `locale:key`, same
 * shape as `ALLOW_SAME_AS_EN_SCOPED` above.
 *
 *  - `zh-Hant:nav.footerNote`: the English source is two short sentences
 *    ("This site offers free preview chapters. The full story is on the
 *    original platform."); the Traditional Chinese translation joins them
 *    with a comma into one sentence ("本站提供免費試讀章節,完整故事請前往原始平台閱讀。")
 *    — an ordinary, idiomatic Chinese construction for two short related
 *    clauses (every English clause is represented; nothing is truncated).
 *    The other three multi-sentence keys in this same zh-Hant catalog
 *    (`unavailable.unpublishedBody`, `blog.unpublishedBody`, `errorPage.
 *    body`) all keep the 2-sentence split, so this is a one-off per-key
 *    style choice, not a systemic zh-Hant rule gap. Pre-existing at
 *    `f1ccf6f`; not touched by this pass (施工纪律：不改任何译文措辞).
 */
const SENTENCE_COUNT_EXCEPTIONS: ReadonlySet<string> = new Set(["zh-Hant:nav.footerNote"]);

describe("message catalog completeness (all 15 registered locales)", () => {
  it("SITE_LOCALES and CATALOGS agree on the set of registered locales", () => {
    expect(new Set(Object.keys(CATALOGS))).toEqual(new Set(SITE_LOCALES));
  });

  /**
   * 低危清扫第 1 批 · item D-①: a dedicated guard on the `CATALOGS` export
   * itself, scoped narrower than the key-set assertion above.
   *
   * The 15-vs-15/no-extra-keys claim is already covered above via
   * `Object.keys(CATALOGS)` vs `SITE_LOCALES` — this block adds the one
   * thing that check can't see: that `CATALOGS.en` is the *exact same
   * object* as `en` (not a structurally-equal duplicate some future edit
   * could accidentally re-declare), since every other assertion in this
   * file — `EN_LEAVES`/`EN_KEYS` included — is built from `en` directly and
   * silently trusts that `CATALOGS.en` is that same reference.
   */
  describe("CATALOGS export guard", () => {
    it("has exactly SITE_LOCALES.length entries, no more, no fewer", () => {
      expect(Object.keys(CATALOGS).length).toBe(SITE_LOCALES.length);
    });

    it("every SITE_LOCALES entry has a corresponding CATALOGS entry, and vice versa", () => {
      const catalogKeys = new Set(Object.keys(CATALOGS));
      for (const locale of SITE_LOCALES) {
        expect(catalogKeys.has(locale)).toBe(true);
      }
      for (const key of catalogKeys) {
        expect(SITE_LOCALES).toContain(key);
      }
    });

    it("CATALOGS.en is the same object reference as the en module's own export", () => {
      expect(CATALOGS.en).toBe(en);
    });
  });

  it.each(SITE_LOCALES)("%s: key set matches the English catalog exactly (no missing, no extra)", (locale) => {
    const catalog = CATALOGS[locale];
    const leaves = flattenLeaves(catalog);
    const localeKeys = new Set(leaves.keys());
    const missing = [...EN_KEYS].filter((k) => !localeKeys.has(k));
    const extra = [...localeKeys].filter((k) => !EN_KEYS.has(k));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it.each(NON_EN_LOCALES)("%s: every value is a non-empty, non-whitespace string", (locale) => {
    const leaves = flattenLeaves(CATALOGS[locale]);
    const blank: string[] = [];
    for (const key of EN_KEYS) {
      const value = leaves.get(key);
      if (typeof value !== "string" || value.trim().length === 0) {
        blank.push(key);
      }
    }
    expect(blank).toEqual([]);
  });

  /**
   * 施工工单_I18N_复数能力 §5 point 2: replaces the pre-step-4 regex-based
   * `interpolationVars` comparison with an AST-derived argument-name set.
   * The regex (`/\{([a-zA-Z0-9_]+)\}/g`) is blind to `{count, plural, ...}`
   * — it would see zero placeholders in a plural message and falsely flag
   * every locale that upgrades a key to `plural` as "missing" whatever
   * argument English's bare `{count}` uses. `inspect()`'s `args` set adds
   * a plural node's own selector name (`count`) once per message,
   * regardless of how many branches are inside it or whether individual
   * branches echo `{count}` in their own text (English's `one` branch and
   * every id/ja/ko/th/vi/zh-Hant `previewChaptersDescription` `one`-less
   * fold both rely on this — see 附录 D 引用 note in the plural-fold
   * commits) — so a `one` branch that legitimately omits `{count}` (a
   * hardcoded "1", correct only where `one` means literally 1) is not
   * mistaken for a placeholder mismatch. This also catches 施工工单 §3.2's
   * apostrophe-eats-placeholder trap: `l'{count}` folds to a literal `l`
   * with no `count` argument at all, so its arg set becomes `{}` and
   * mismatches English's `{count}` — exactly the failure mode this check
   * exists to catch.
   */
  it.each(NON_EN_LOCALES)("%s: interpolation variables (including ICU plural arguments) match the English source exactly, per key", (locale) => {
    const leaves = flattenLeaves(CATALOGS[locale]);
    const mismatches: string[] = [];
    for (const key of EN_KEYS) {
      const enValue = EN_LEAVES.get(key) as string;
      const localeValue = leaves.get(key);
      if (typeof localeValue !== "string") continue; // already reported by the previous check
      // Deliberately not named `en`: that is the imported English catalog at
      // module scope, and shadowing it inside this loop makes any later use of
      // the catalog here silently resolve to an `InspectResult` instead.
      const enInspected = inspect(enValue);
      if ("parseError" in enInspected) {
        // en.ts's own parseability is already asserted by the banned-ICU-form
        // test below (scoped to all SITE_LOCALES, en included) — skip here to
        // avoid reporting the same underlying problem once per non-en locale.
        continue;
      }
      const lo = inspect(localeValue);
      if ("parseError" in lo) {
        mismatches.push(`${key}: ${locale} unparseable: ${lo.parseError}`);
        continue;
      }
      const a = [...enInspected.args].sort().join(",");
      const b = [...lo.args].sort().join(",");
      if (a !== b) {
        mismatches.push(`${key}: en={${a}} ${locale}={${b}}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  /**
   * 施工工单_I18N_复数能力 §5 point 1 / 附录 D: replaces the pre-step-4
   * `ICU_SYNTAX_RE` blanket ban (which rejected `plural` outright — now
   * wrong, catalogs legitimately use it) with an AST walk that allows only
   * cardinal `plural` among ICU argument forms, plus four related bans
   * called out in the work order (the fourth — `#` — added by Owner 拍板
   * 2026-09-10, 承诺句英文口径 item 6):
   *
   *  - `select` / `selectordinal` / `number` / `date` / `time` / tag —
   *    forms `t()` never supported and still doesn't (施工工单 §5.1 point 1;
   *    `selectordinal` parses as a `plural` node with `pluralType:
   *    "ordinal"`, caught separately since `TYPE` alone can't see it).
   *  - `=N` exact-match branches (e.g. `=1 {...}`) — legal ICU, and it
   *    would parse and even render correctly, but it gives a count of
   *    exactly `N` a *second*, higher-priority route to a branch alongside
   *    its CLDR category, which would make the "categories match exactly,
   *    no more no less" gate below meaningless (施工工单 §5.1 point 1).
   *  - `#` (the ICU `pound` element) inside a plural branch — legal ICU
   *    shorthand for "insert the plural's own number here," but a second,
   *    silent path to number substitution alongside `{count}`. Every
   *    catalog branch must spell out `{count}` instead (Owner 拍板
   *    2026-09-10) — `ALLOWED_TYPES` above no longer includes `TYPE.pound`,
   *    so `walk()`'s existing recursion into plural branches routes any `#`
   *    through the same generic ban path as `select`/`tag`/etc.
   *  - doubled apostrophe `''` — ICU's escape for a literal apostrophe
   *    (`don''t` → `don't`). No catalog value uses it today (施工工单
   *    §3.2), and banning it now keeps that true, since it is a second,
   *    behaviorally-different way to write what a plain `'` already writes
   *    correctly under formatjs's DOUBLE_OPTIONAL apostrophe rule.
   */
  it.each(SITE_LOCALES)("%s: no banned ICU form (only cardinal plural allowed; select/selectordinal/number/date/time/tag, `=N` exact-match branches, `#` inside a plural branch, and doubled apostrophes are banned)", (locale) => {
    const leaves = flattenLeaves(CATALOGS[locale]);
    const offenders: string[] = [];
    for (const [key, value] of leaves) {
      if (typeof value !== "string") continue;
      if (value.includes("''")) {
        offenders.push(`${key}: doubled apostrophe '' — ${value}`);
      }
      const result = inspect(value);
      if ("parseError" in result) {
        offenders.push(`${key}: unparseable ICU: ${result.parseError}`);
        continue;
      }
      if (result.banned.length) {
        offenders.push(`${key}: banned ICU form(s) ${[...new Set(result.banned)].join(",")}`);
      }
      for (const plural of result.plurals) {
        if (plural.exact.length) {
          offenders.push(`${key}: exact-match branch(es) ${plural.exact.join(",")} — banned, use CLDR categories only`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Owner 拍板 2026-09-10 (承诺句英文口径 item 6) — the red-proof half of
   * the `#`-inside-plural ban directly above: exercises `inspect()` on a
   * synthetic message rather than planting a `#` in a real catalog file
   * (which would need reverting immediately after). Confirms the ban fires
   * exactly where it should (inside a plural branch), stays silent where it
   * shouldn't (a literal `#` outside any plural has no special ICU meaning
   * and is plain text), and that `{count}` — the required replacement —
   * never trips it.
   */
  describe("`#` inside a plural branch — red-proof for the ban added above", () => {
    it("a plural branch using `#` is reported as a banned `pound` form", () => {
      const result = inspect("{count, plural, one {# x} other {# y}}");
      expect("parseError" in result).toBe(false);
      if ("parseError" in result) return;
      expect(result.banned).toEqual(["pound", "pound"]);
    });

    it("the same message rewritten with `{count}` instead of `#` is clean (no banned forms)", () => {
      const result = inspect("{count, plural, one {{count} x} other {{count} y}}");
      expect("parseError" in result).toBe(false);
      if ("parseError" in result) return;
      expect(result.banned).toEqual([]);
    });

    it("a literal `#` outside any plural is plain text, not banned", () => {
      const result = inspect("Room #{count}");
      expect("parseError" in result).toBe(false);
      if ("parseError" in result) return;
      expect(result.banned).toEqual([]);
    });
  });

  /**
   * 施工工单_I18N_复数能力 §5 point 3（Owner 要的核心门禁）: every plural
   * block, in every locale, must cover *exactly* that locale's CLDR
   * category set — no missing category (a silently-unreachable-but-legal
   * count falls back to whichever branch ICU picks, which for a category
   * that isn't there at all is `other`, quietly wrong for that count) and
   * no extra category (a category that can never fire for this locale is
   * dead weight that makes "which counts does this branch handle" harder
   * to audit, and — more importantly — an extra branch some locale doesn't
   * have is exactly how `id`/`ja`/`ko`/`th`/`vi`/`zh-Hant` would break if
   * someone pasted in a `one` branch that could never be selected there;
   * see the per-file 施工工单 §6.2 comments on those six catalogs).
   *
   * Compares against the frozen `EXPECTED_PLURAL_CATEGORIES` table, not
   * `Intl.PluralRules` directly — see that constant's own comment for why.
   */
  it.each(SITE_LOCALES)("%s: every plural key covers exactly its locale's CLDR categories (no missing, no extra)", (locale) => {
    const leaves = flattenLeaves(CATALOGS[locale]);
    const expected = new Set(EXPECTED_PLURAL_CATEGORIES[locale]);
    const offenders: string[] = [];
    for (const [key, value] of leaves) {
      if (typeof value !== "string") continue;
      const result = inspect(value);
      if ("parseError" in result) continue; // already reported by the banned-ICU-form test
      for (const plural of result.plurals) {
        const got = new Set(plural.categories);
        const missing = [...expected].filter((c) => !got.has(c));
        const extra = [...got].filter((c) => !expected.has(c));
        if (missing.length || extra.length) {
          offenders.push(
            `${key}: ${locale} plural {${plural.name}} missing=[${missing}] extra=[${extra}] (expected: ${[...expected].sort().join(",")})`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * 施工工单_I18N_复数能力 §5.1 第三条: the anti-drift half of the CLDR
   * coverage gate above. `EXPECTED_PLURAL_CATEGORIES` is a frozen,
   * hand-reviewed table so that catalog completeness doesn't silently
   * redefine itself on every Node/ICU upgrade — but a frozen table is only
   * trustworthy if something keeps it honest against the runtime it's
   * meant to describe. This is that something: if a future Node/ICU
   * upgrade changes a locale's actual `Intl.PluralRules` category set
   * (CLDR does revise these — `many` was added to fr/es/pt-BR in CLDR 42),
   * this test goes red with a clear "the table is stale" signal, instead
   * of the coverage test above going red for 15 locales at once with a
   * diff that looks like a translation regression.
   */
  it.each(SITE_LOCALES)("%s: EXPECTED_PLURAL_CATEGORIES matches the runtime Intl.PluralRules category set", (locale) => {
    const runtime = [...new Intl.PluralRules(locale).resolvedOptions().pluralCategories].sort();
    const frozen = [...EXPECTED_PLURAL_CATEGORIES[locale]].sort();
    expect(frozen).toEqual(runtime);
  });

  it.each(NON_EN_LOCALES)("%s: rendering every interpolated key through the real t() leaves no stray braces", (locale) => {
    const messages = loadMessages(locale);
    const sampleVars: Record<string, string | number> = {
      n: 2,
      count: 3,
      title: "Sample",
      number: 5,
      index: 2,
      total: 4,
      name: "Sample",
      date: "2026-09-08",
      digest: "abc123",
      current: 2,
    };
    const leftoverBraces: string[] = [];
    for (const key of EN_KEYS) {
      const enValue = EN_LEAVES.get(key) as string;
      const vars = interpolationVars(enValue);
      if (vars.size === 0) continue;
      const rendered = t(messages, key as MessageKey, locale, sampleVars);
      if (/\{[a-zA-Z0-9_]+\}/.test(rendered)) {
        leftoverBraces.push(`${key}: ${rendered}`);
      }
    }
    expect(leftoverBraces).toEqual([]);
  });

  it.each(NON_EN_LOCALES)(
    "%s: leftover-English detection — a value identical to English must be on the allowlist (suggested, 工单三 §10.3 item 6)",
    (locale) => {
      const leaves = flattenLeaves(CATALOGS[locale]);
      const unexplained: string[] = [];
      for (const key of EN_KEYS) {
        const enValue = EN_LEAVES.get(key) as string;
        const localeValue = leaves.get(key);
        if (typeof localeValue !== "string") continue;
        if (normalizeForResidueComparison(localeValue) !== normalizeForResidueComparison(enValue)) continue;
        if (ALLOW_SAME_AS_EN.has(key)) continue;
        if (ALLOW_SAME_AS_EN_SCOPED.has(`${locale}:${key}`)) continue;
        unexplained.push(key);
      }
      expect(unexplained).toEqual([]);
    },
  );

  /**
   * Sentence-count parity gate — see `SENTENCE_COUNT_LOCALES`'s own doc
   * comment above for the terminator sets, the two minimal disambiguation
   * rules, the `th` exemption, and the plural-key exclusion rationale.
   *
   * Red-proof (施工报告_公开页description与句数门禁_2026-09-10 任务 2 point
   * 3): temporarily deleting the second sentence from `ar.ts`'s
   * `unavailable.unpublishedBody` (a real 2-sentence key in both en and ar
   * today) turns the `ar` case of the test below red with exactly the
   * `unavailable.unpublishedBody: en=2 ar=1` mismatch line, and reverting
   * the file turns it back green — see the construction report for the
   * captured before/after run.
   */
  it("th is explicitly exempted from the sentence-count gate (no sentence-final punctuation convention)", () => {
    expect(NON_EN_LOCALES).toContain("th");
    expect(SENTENCE_COUNT_LOCALES).not.toContain("th");
  });

  it.each(SENTENCE_COUNT_LOCALES)(
    "%s: sentence count matches English for every multi-sentence key (en has >= 2 sentences, non-plural)",
    (locale) => {
      const leaves = flattenLeaves(CATALOGS[locale]);
      const mismatches: string[] = [];
      for (const key of EN_KEYS) {
        const enValue = EN_LEAVES.get(key);
        if (typeof enValue !== "string") continue;
        const enInspected = inspect(enValue);
        // Unparseable English is already reported by the banned-ICU-form
        // test above; a plural key is out of scope (see the doc comment on
        // `SENTENCE_COUNT_LOCALES`).
        if ("parseError" in enInspected || enInspected.plurals.length > 0) continue;
        const enCount = countSentences(enValue, "en");
        if (enCount < 2) continue; // single-sentence keys have no count to diverge on
        const localeValue = leaves.get(key);
        if (typeof localeValue !== "string") continue; // already reported by the key-set/blank-value checks above
        const localeCount = countSentences(localeValue, locale);
        if (localeCount === enCount) continue;
        if (SENTENCE_COUNT_EXCEPTIONS.has(`${locale}:${key}`)) continue;
        mismatches.push(`${key}: en=${enCount} ${locale}=${localeCount} — en="${enValue}" ${locale}="${localeValue}"`);
      }
      expect(mismatches).toEqual([]);
    },
  );
});
