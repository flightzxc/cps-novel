import IntlMessageFormat, { MissingValueError } from "intl-messageformat";

import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

import { en, type LocaleMessages, type Messages } from "./en";
import ar from "./ar";
import cs from "./cs";
import de from "./de";
import es from "./es";
import fr from "./fr";
import id from "./id";
import ja from "./ja";
import ko from "./ko";
import pl from "./pl";
import ptBR from "./pt-BR";
import ru from "./ru";
import th from "./th";
import vi from "./vi";
import zhHant from "./zh-Hant";

export type { Messages } from "./en";
export { en };

export type MessageVars = Record<string, string | number>;

type MessageLeaves<T, Prefix extends string = ""> = T extends string
  ? Prefix
  : {
      [K in keyof T & string]: MessageLeaves<T[K], Prefix extends "" ? K : `${Prefix}.${K}`>;
    }[keyof T & string];

export type MessageKey = MessageLeaves<Messages>;

export class MissingMessagesError extends Error {
  readonly locale: SiteLocale;

  constructor(locale: SiteLocale, detail?: string) {
    super(detail ? `Missing messages for locale "${locale}": ${detail}` : `Missing messages for locale "${locale}"`);
    this.name = "MissingMessagesError";
    this.locale = locale;
  }
}

/**
 * Raw per-locale catalogs, keyed by `SiteLocale`, **before** the English
 * fallback merge in `loadMessages` runs. Exported only for
 * `tests/ui/messages-completeness.test.ts` (and any future translation-
 * coverage tooling) — production code must go through `loadMessages` /
 * `getPublicT`, never read this map directly, or it sees raw gaps instead
 * of the English fallback text a real page renders.
 */
export const CATALOGS: Readonly<Record<SiteLocale, Messages | Partial<LocaleMessages>>> = {
  en,
  es,
  "pt-BR": ptBR,
  id,
  vi,
  th,
  ja,
  ko,
  "zh-Hant": zhHant,
  ar,
  fr,
  de,
  pl,
  cs,
  ru,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lookup(tree: unknown, path: string[]): unknown {
  let current: unknown = tree;
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Deep-merge `override` onto `base` (English), key by key, following the
 * shape of `base`. A value in `override` only wins when it is a non-empty,
 * non-whitespace string — anything else (missing key, `undefined`, an empty
 * string, a stray non-string) silently keeps the English value. Traversal
 * follows `base`'s keys, not `override`'s, so an incomplete or even
 * structurally-wrong translation catalog can never introduce a key that
 * isn't in `Messages`, and can never remove one either.
 *
 * This is the runtime half of Owner 修正一 (2026-09-08 施工工单 §十.1):
 * a missing/blank translation falls back to English at render time and the
 * page renders — it is never a thrown error. Completeness (every key
 * present, every value non-empty, interpolation variables matching, no ICU
 * syntax) is enforced separately, at test time, by
 * `tests/ui/messages-completeness.test.ts`.
 */
function deepMergeOntoEnglish<T>(base: T, override: unknown): T {
  if (!isRecord(base)) return base;
  const overrideRecord = isRecord(override) ? override : {};
  const merged: Record<string, unknown> = {};
  for (const [key, baseValue] of Object.entries(base)) {
    const overrideValue = overrideRecord[key];
    if (isRecord(baseValue)) {
      merged[key] = deepMergeOntoEnglish(baseValue, overrideValue);
    } else if (typeof overrideValue === "string" && overrideValue.trim().length > 0) {
      merged[key] = overrideValue;
    } else {
      merged[key] = baseValue;
    }
  }
  return merged as T;
}

/** Per-locale memoized merge result — `loadMessages` runs on every `SiteShell` render (`SiteShell.tsx:46`); the deep merge itself doesn't need to redo on every call. */
const mergedMessagesCache = new Map<SiteLocale, Messages>();

/**
 * Test/dev-only escape hatch: clears *every* module-level cache in this file
 * — both `mergedMessagesCache` (the per-locale deep-merge result) and
 * `messageFormatCache` (the compiled `IntlMessageFormat` instances declared
 * further down).
 *
 * Production code must never call this — the production path always serves
 * from (and populates) those maps, and this function has no effect on them
 * beyond emptying them. It exists for the rare test that needs to observe
 * the *cache itself* (e.g. stubbing `NODE_ENV` to `"production"` to
 * exercise the memoized branch below) — without a reset, a merge cached
 * under a stubbed env would otherwise leak into whichever test runs next,
 * since both maps are module-level state shared across the whole test
 * file/process.
 *
 * `messageFormatCache` is cleared here even though no test observes it today
 * and no stale read is reachable through it (its key embeds the full message
 * text, so a changed message is a different key, and the key space is
 * bounded by the static catalogs). The point is that a function named "reset
 * the messages cache" should leave this module holding no retained state at
 * all: once there are two caches and the reset only empties one, the next
 * person to stub a catalog value and call this has to read the
 * implementation to find out which half actually reset.
 */
export function resetMessagesCacheForTests(): void {
  mergedMessagesCache.clear();
  messageFormatCache.clear();
}

/**
 * Load a locale catalog, deep-merged onto English (Owner 修正一).
 *
 * `en` short-circuits and returns the `en` object itself (no merge, no
 * allocation) — `loadMessages("en") === en` stays a reference-equality
 * fact any caller can rely on. Every other locale gets `en` deep-merged
 * with that locale's (possibly incomplete) catalog. A missing entry in
 * `CATALOGS` (should not happen for a registered `SiteLocale`, but the
 * lookup is still a plain object index) falls back to an empty override,
 * i.e. the full English catalog — never a thrown error at render time.
 *
 * Memoization only runs when `NODE_ENV === "production"`. Outside of that
 * (`development`, `test`, anything else) every call recomputes the merge
 * instead of reading `mergedMessagesCache` — a locale file edited during
 * `next dev` must be reflected without a full server restart, and this
 * module's cache is plain module-level state that a Fast Refresh boundary
 * is not guaranteed to reset. Recomputing is cheap (a handful of small
 * object merges) and `deepMergeOntoEnglish` is pure, so skipping the cache
 * changes nothing about the result — only the production hot path keeps
 * the memoized fast path, where a Next.js server process's module graph is
 * loaded once and correctly expected to stay put for its lifetime.
 */
export function loadMessages(locale: SiteLocale): Messages {
  if (locale === PUBLIC_SITE_LOCALE) return en;

  const catalog = CATALOGS[locale];

  if (process.env.NODE_ENV !== "production") {
    return deepMergeOntoEnglish(en, catalog);
  }

  const cached = mergedMessagesCache.get(locale);
  if (cached) return cached;

  const merged = deepMergeOntoEnglish(en, catalog);
  mergedMessagesCache.set(locale, merged);
  return merged;
}

/**
 * `t()` is invoked dozens of times per render (`SiteShell.tsx` alone touches
 * every nav/footer key), and `new IntlMessageFormat(...)` re-parses the ICU
 * string into an AST plus compiled plural/number-format closures on every
 * construction — work worth memoizing rather than repeating per call.
 *
 * Cache key is `${locale} ${message}`. This cannot collide across distinct
 * `(locale, message)` pairs: `locale` is always exactly one of the 15
 * `SiteLocale` string literals (`"en"`, `"pt-BR"`, `"zh-Hant"`, ...), none of
 * which contain a space, so the leading `"<locale> "` segment of the key
 * unambiguously identifies which locale a given cached instance belongs to
 * regardless of what the message text itself contains.
 */
const messageFormatCache = new Map<string, IntlMessageFormat>();

function getMessageFormat(locale: SiteLocale, message: string): IntlMessageFormat {
  const cacheKey = `${locale} ${message}`;
  const cached = messageFormatCache.get(cacheKey);
  if (cached) return cached;
  const format = new IntlMessageFormat(message, locale);
  messageFormatCache.set(cacheKey, format);
  return format;
}

/**
 * Renders `messages[key]` through `intl-messageformat` (CPS's own plural
 * engine — 施工工单_I18N_复数能力 §三/§4.2), so a catalog value written as
 * plain `{name}` interpolation or as an ICU `{count, plural, ...}` block
 * renders identically through this one function; which form a given locale
 * uses is a per-message choice made in that locale's catalog file, not
 * something callers of `t()` need to know about.
 *
 * Two failure modes, both fail-loud by design (no silent degrade to raw
 * `{braces}` on the page):
 *
 *  - Missing/blank key → `MissingMessagesError`, unchanged from before this
 *    engine swap.
 *  - A variable the message needs was not supplied → `intl-messageformat`
 *    throws `MissingValueError`; caught here and re-wrapped as
 *    `MissingMessagesError` so the error type this module exposes stays the
 *    same regardless of which engine is doing the rendering underneath.
 *    This is strictly *stricter* than the old hand-rolled regex replace
 *    (which silently returned the raw template when `vars` was omitted,
 *    施工工单 §4.4) — the one prior call site that relied on the loose
 *    behavior (`PreviewChapterList.tsx`'s no-placeholder `...One` key) is
 *    folded away in this same change (§6.2), so nothing depends on it.
 */
export function t(messages: Messages, key: MessageKey, locale: SiteLocale, vars?: MessageVars): string {
  const value = lookup(messages, key.split("."));
  if (typeof value !== "string" || value.length === 0) {
    throw new MissingMessagesError("en", key);
  }

  const format = getMessageFormat(locale, value);
  let result: ReturnType<IntlMessageFormat["format"]>;
  try {
    result = format.format(vars ?? {});
  } catch (error) {
    if (error instanceof MissingValueError) {
      throw new MissingMessagesError("en", `${key}: ${error.message}`);
    }
    throw error;
  }

  // Defensive assertion, not a reachable path today: the completeness gate
  // (`tests/ui/messages-completeness.test.ts`) bans the ICU `tag` form that
  // is the only way `format()` can return non-string parts, so this should
  // never fire against a catalog that passes the gate.
  if (typeof result !== "string") {
    throw new Error(`${key}: message did not resolve to a string (rich-text interpolation is not supported)`);
  }
  return result;
}

export type Translator = (key: MessageKey, vars?: MessageVars) => string;

export function createTranslator(messages: Messages, locale: SiteLocale): Translator {
  return (key, vars) => t(messages, key, locale, vars);
}

/**
 * 🔴 P0-S14：`locale` 没有默认值，故意的。曾经的 `= PUBLIC_SITE_LOCALE`
 * 默认参数，让 17 处调用点悄悄靠一个隐式常量拿到英文——第二语种接入那天，
 * 这些调用点一个都不会报错，只会继续吐英文文案，直到有人肉眼发现页面语种
 * 不对。这正是 CPS `v6.0.4` 事故的形状（登记链路有缺口，事故要等上线后才
 * 现形）。去掉默认值以后，任何调用点漏传 locale 就是编译错误，不是运行时
 * 静默降级。
 */
export function getPublicT(locale: SiteLocale): Translator {
  return createTranslator(loadMessages(locale), locale);
}
