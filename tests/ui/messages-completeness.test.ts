import { describe, expect, it } from "vitest";

import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { CATALOGS, loadMessages, t, type MessageKey } from "@/lib/locale/messages";
import { en } from "@/lib/locale/messages/en";

/**
 * Completeness gate for the 15 registered-locale message catalogs (工单三
 * §10.3, Owner 修正一).
 *
 * `loadMessages` deep-merges every locale onto English at *runtime* and
 * never throws — a missing or blank translation quietly renders the
 * English text instead (`src/lib/locale/messages/index.ts`). That is
 * exactly why this file exists: nothing in the render path will ever flag
 * a translation gap, so completeness has to be enforced here, at test
 * time, against the **raw** per-locale catalogs (`CATALOGS`, pre-merge) —
 * checking the merged/fallback result would just see English everywhere
 * and could never catch a missing key, an empty string, a mismatched
 * interpolation variable, or stray ICU syntax.
 *
 * 短剧站的教训（工单三 §10.3 引用）：CPS 有深合并回落，但没有一条覆盖全目录
 * 的完整性测试——只有五个局部命名空间守卫，回落把缺口悄悄补成英文，没有任何
 * 测试注意到十五套目录里平均每套躺着 20.6 条未翻译的英文原文。这份文件就是
 * 补上那半个机制：回落在运行时、完整性在 CI，两半缺一不可。
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

/** `{var, plural, ...}` / `{var, select, ...}` / `{var, selectordinal, ...}` — the ICU syntax `t()` cannot parse (index.ts:105's regex only matches bare `{name}`). */
const ICU_SYNTAX_RE = /\{\s*\w+\s*,\s*(plural|select|selectordinal)\b/;

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

  it.each(NON_EN_LOCALES)("%s: interpolation variables match the English source exactly, per key", (locale) => {
    const leaves = flattenLeaves(CATALOGS[locale]);
    const mismatches: string[] = [];
    for (const key of EN_KEYS) {
      const enValue = EN_LEAVES.get(key) as string;
      const localeValue = leaves.get(key);
      if (typeof localeValue !== "string") continue; // already reported by the previous check
      const enVars = interpolationVars(enValue);
      const localeVars = interpolationVars(localeValue);
      const same = enVars.size === localeVars.size && [...enVars].every((v) => localeVars.has(v));
      if (!same) {
        mismatches.push(`${key}: en={${[...enVars].join(",")}} ${locale}={${[...localeVars].join(",")}}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  /**
   * 低危清扫第 1 批 · item D-⑦: this scan used to run only over
   * `NON_EN_LOCALES` — `en.ts` itself, the source of truth every other
   * catalog is translated from and deep-merged onto, was never checked for
   * ICU syntax. A stray `{count, plural, ...}` typo'd into `en.ts` would
   * both (a) render literally on the English site (`t()` only does bare
   * `{name}` substitution, `index.ts`'s regex) and (b) silently become the
   * fallback text for every locale whose own translation is blank/missing —
   * i.e. the one catalog most worth banning ICU from was the one this test
   * skipped. Scoped to `SITE_LOCALES` (all 15, `en` included) instead.
   */
  it.each(SITE_LOCALES)("%s: no ICU plural/select/selectordinal syntax (t() only does {name} substitution)", (locale) => {
    const leaves = flattenLeaves(CATALOGS[locale]);
    const offenders: string[] = [];
    for (const [key, value] of leaves) {
      if (typeof value === "string" && ICU_SYNTAX_RE.test(value)) {
        offenders.push(`${key}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
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
      const rendered = t(messages, key as MessageKey, sampleVars);
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
});
