/**
 * L10N P1 — upstream language-code → locale resolution, COPY/ADAPT of CPS
 * `3a76877:src/lib/channel-language.ts` (see
 * `施工提示词_Sonnet_L10N_P1_语言归一与存量重算_2026-09-10.md` §1.A and
 * `docs/governance/port-registry.md`'s L10N P1 section for the line-by-line
 * mapping).
 *
 * CPS's original file indexes its registry by `channelAppKey` (`beidou`,
 * `changdu_moboreels`, `changdu_<sourceApp>`, …) because CPS ingests from
 * multiple channels/source apps that each have their own numeric code
 * table. This repo has exactly one upstream source app — `moboreader` — so
 * the by-source-app indexing shape is kept (`LANGUAGE_REGISTRY_BY_SOURCE_APP`
 * mirrors CPS's `CHANGDU_LANGUAGE_REGISTRY_BY_SOURCE_APP`) but narrowed to a
 * single key. The `channel`/`channelAppKey`/`label` fields CPS's resolution
 * DTO carries (multi-channel plumbing, `LOCALE_LABEL` lookup) are dropped —
 * nothing in this repo consumes them yet; add them back only when a real
 * caller needs them, not preemptively.
 *
 * Code-table values come ONLY from
 * `docs/governance/L10N_UPSTREAM_LANGUAGE_EVIDENCE_2026-09-10.md` — real
 * paired `(language, languageName)` evidence read from this repo's own X8
 * database (`novel_source_item`), not copied wholesale from CPS's changdu
 * table. The 18 codes registered below happen to have the same code→locale
 * values as CPS's `CHANGDU_SHORTMAX_LANGUAGE_CODE_TO_LOCALE`
 * (`changdu_moboreels`'s registry minus codes 17/23 plus 23, i.e. the
 * "common changdu + pl" set) — that is a same-vendor cross-check, not the
 * source of truth. Codes `19`/`20` (upstream `languageName` is JSON `null`
 * for both, 5,577 and 10,393 rows respectively) have zero paired evidence
 * and are deliberately NOT registered — `resolveChannelLanguage` falls
 * through to `locale: null, confidence: "unknown"` for them, exactly like
 * any other unregistered code.
 */

export type ChannelLanguageConfidence =
  | "confirmed_code_mapping"
  | "confirmed_name_alias"
  | "tentative"
  | "unknown";

export type ResolvedChannelLanguageConfidence = "code" | "name_alias" | "unknown";

export type ChannelLanguageWarning = {
  type: "code_name_conflict";
  sourceAppCode: string;
  rawSourceLanguageCode: string;
  resolvedLocale: string | null;
  evidence: ChannelLanguageConfidence;
  codeLocale: string;
  nameLocale: string;
  sourceLanguageCode: string;
  sourceLanguageName: string;
};

export type ChannelLanguageResolution = {
  sourceAppCode: string;
  sourceLanguageCode: string;
  locale: string | null;
  confidence: ResolvedChannelLanguageConfidence;
  evidence: ChannelLanguageConfidence;
  warning: ChannelLanguageWarning | null;
};

/** Aligns with CPS `changdu-dry-run.ts`'s catalog-sync filter sentinel. */
export const UNKNOWN_SOURCE_LOCALE_FILTER = "__unknown";

/** The single upstream source app this repo ingests from. */
export const MOBOREADER_SOURCE_APP_CODE = "moboreader";

type CodeMapping = {
  locale: string;
  evidence: ChannelLanguageConfidence;
};

/**
 * `code → locale`, moboreader source app. Values are transcribed verbatim
 * from `docs/governance/L10N_UPSTREAM_LANGUAGE_EVIDENCE_2026-09-10.md`'s
 * evidence table — every entry here has a real paired
 * `(source_language_code, source_language_name)` sample in this repo's own
 * X8 database. Codes `19`/`20` (paired `languageName` is `null`) are
 * deliberately absent — see this file's header.
 *
 * `it`/`fil`/`ms`/`tr` resolve successfully here but are NOT `SiteLocale`
 * members (`src/lib/locale/locale-canonical.ts`'s `SITE_LOCALES`) — "mapped
 * to a locale" and "is a publishable/registered site locale" are two
 * independent questions, exactly as `locale-canonical.ts`'s own doc comment
 * already establishes for the site-locale layer. This registry only answers
 * the first question.
 */
export const MOBOREADER_LANGUAGE_CODE_TO_LOCALE: Readonly<Record<string, string>> = Object.freeze({
  "2": "zh-Hant",
  "3": "en",
  "4": "es",
  "5": "pt-BR",
  "6": "fr",
  "7": "ru",
  "8": "it",
  "9": "ja",
  "10": "ar",
  "11": "id",
  "12": "th",
  "13": "vi",
  "14": "ko",
  "15": "fil",
  "16": "de",
  "21": "ms",
  "22": "tr",
  "23": "pl",
});

const MOBOREADER_LANGUAGE_REGISTRY: Readonly<Record<string, CodeMapping>> = Object.freeze(
  Object.fromEntries(
    Object.entries(MOBOREADER_LANGUAGE_CODE_TO_LOCALE).map(([code, locale]) => [
      code,
      { locale, evidence: "confirmed_code_mapping" as const },
    ]),
  ),
);

/**
 * Registry keyed by upstream source app. Only one key exists today
 * (`moboreader`) — kept as a by-source-app map (rather than a flat
 * code→locale table) for the same reason CPS keeps
 * `CHANGDU_LANGUAGE_REGISTRY_BY_SOURCE_APP` shaped this way: a second
 * source app, if one is ever onboarded, gets its own registry key instead
 * of forcing every caller to thread a channel-specific code table through
 * by hand.
 */
const LANGUAGE_REGISTRY_BY_SOURCE_APP: Readonly<Record<string, Readonly<Record<string, CodeMapping>>>> =
  Object.freeze({
    [MOBOREADER_SOURCE_APP_CODE]: MOBOREADER_LANGUAGE_REGISTRY,
  });

/**
 * Name-alias fallback table. COPY of CPS
 * `3a76877:src/lib/channel-language.ts`'s `LANGUAGE_NAME_ALIAS_TO_LOCALE`,
 * verbatim (all entries, not filtered to the 18 codes above) — every one of
 * this repo's 18 upstream `languageName` samples already exists in CPS's
 * table under the exact same key, so no additions were needed; kept as a
 * full copy rather than a filtered subset so a future code whose
 * `languageName` matches an already-registered alias (e.g. `hi`/印地语,
 * `ro`) resolves by name without a second port pass. Simplified Chinese
 * variants map to explicit `null` (never guessed as `zh-Hant` or any other
 * locale) — see `resolveLanguageNameAlias`'s doc comment for why that still
 * surfaces as `confidence: "unknown"`, not a distinct "recognized but
 * intentionally unmapped" state.
 *
 * Exported (not just module-private) so
 * `tests/backend/locale/channel-language.test.ts` can snapshot-pin the
 * simplified-Chinese explicit-`null` entries directly against this table,
 * rather than only indirectly through `resolveLanguageNameAlias`'s
 * normalize-then-lookup behavior (Opus 复核 NON_BLOCKING b②) — exporting it
 * does not create a second mapping table: this file is one of the two
 * `CANONICAL_SOURCE_PATHS` `tests/ui/locale-canonical.test.ts` already
 * excludes from its "no second mapping table" scan.
 */
export const LANGUAGE_NAME_ALIAS_TO_LOCALE: Readonly<Record<string, string | null>> = Object.freeze({
  english: "en",
  en: "en",
  英语: "en",
  英文: "en",
  spanish: "es",
  es: "es",
  西语: "es",
  西班牙语: "es",
  portuguese: "pt-BR",
  pt: "pt-BR",
  "pt-br": "pt-BR",
  葡语: "pt-BR",
  葡萄牙语: "pt-BR",
  french: "fr",
  fr: "fr",
  法语: "fr",
  russian: "ru",
  ru: "ru",
  俄语: "ru",
  italian: "it",
  it: "it",
  意大利语: "it",
  japanese: "ja",
  ja: "ja",
  日语: "ja",
  arabic: "ar",
  ar: "ar",
  阿拉伯语: "ar",
  indonesian: "id",
  id: "id",
  印尼: "id",
  印尼语: "id",
  thai: "th",
  th: "th",
  泰语: "th",
  vietnamese: "vi",
  vi: "vi",
  越南语: "vi",
  korean: "ko",
  ko: "ko",
  韩语: "ko",
  filipino: "fil",
  tagalog: "fil",
  fil: "fil",
  tl: "fil",
  菲律宾语: "fil",
  german: "de",
  de: "de",
  德语: "de",
  hindi: "hi",
  hi: "hi",
  印地语: "hi",
  malay: "ms",
  malaysian: "ms",
  ms: "ms",
  马来语: "ms",
  马来西亚语: "ms",
  turkish: "tr",
  tr: "tr",
  土耳其语: "tr",
  polish: "pl",
  pl: "pl",
  波兰语: "pl",
  "traditional chinese": "zh-Hant",
  chinese_traditional: "zh-Hant",
  "zh-hant": "zh-Hant",
  "zh-tw": "zh-Hant",
  中文繁体: "zh-Hant",
  繁体中文: "zh-Hant",
  繁体: "zh-Hant",
  繁體: "zh-Hant",
  中文繁體: "zh-Hant",
  繁體中文: "zh-Hant",
  "simplified chinese": null,
  chinese: null,
  chinese_simplified: null,
  zh: null,
  "zh-cn": null,
  中文简体: null,
  简体中文: null,
  简体: null,
  簡體: null,
});

/** Opaque mapping-version tag. Bump this string (with a date) whenever the code table or alias table changes. */
export const MAPPING_VERSION = "channel-language:moboreader:v1:2026-09-10";

export function normalizeLanguageAlias(value: string | null | undefined): string {
  return value?.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

/**
 * Resolves a `languageName` string against the alias table. Returns `null`
 * both when the name is unrecognized AND when it is recognized but
 * explicitly mapped to `null` (simplified Chinese) — the caller
 * (`resolveChannelLanguage`) cannot tell the two apart from this return
 * value alone, matching CPS's own `resolveLanguageNameAlias` behavior
 * verbatim (COPY, not a bug fix in scope for this port).
 */
export function resolveLanguageNameAlias(value: string | null | undefined): string | null {
  const normalized = normalizeLanguageAlias(value);
  return normalized ? LANGUAGE_NAME_ALIAS_TO_LOCALE[normalized] ?? null : null;
}

function resolveCodeMapping(sourceAppCode: string, sourceLanguageCode: string): CodeMapping | null {
  if (!sourceLanguageCode) return null;
  return LANGUAGE_REGISTRY_BY_SOURCE_APP[sourceAppCode]?.[sourceLanguageCode] ?? null;
}

/**
 * Resolves one upstream `(sourceLanguageCode, sourceLanguageName)` pair to
 * a locale. ADAPT of CPS `resolveChannelLanguage` — same code-then-name
 * precedence, same `code_name_conflict` warning shape, same
 * `confidence`/`evidence` vocabulary — narrowed to this repo's single
 * source app (`sourceAppCode` defaults to `"moboreader"` when omitted; CPS
 * derives it from `channelAppKey`/`channel`, which this repo has no
 * equivalent of).
 *
 * Never throws: an unrecognized code and an unrecognized name both fall
 * through to `locale: null, confidence: "unknown"` — fail-closed, matching
 * `locale-canonical.ts`'s "映射不到就是 unknown/NULL，不得猜测" discipline.
 */
export function resolveChannelLanguage(input: {
  sourceAppCode?: string | null;
  sourceLanguageCode?: string | number | null;
  sourceLanguageName?: string | null;
}): ChannelLanguageResolution {
  const sourceAppCode = input.sourceAppCode?.trim() || MOBOREADER_SOURCE_APP_CODE;
  const sourceLanguageCode = String(input.sourceLanguageCode ?? "").trim();
  const sourceLanguageName = input.sourceLanguageName?.trim() ?? "";
  const mapping = resolveCodeMapping(sourceAppCode, sourceLanguageCode);
  const nameLocale = resolveLanguageNameAlias(sourceLanguageName);

  if (mapping) {
    const warning: ChannelLanguageWarning | null =
      sourceLanguageName && nameLocale && nameLocale !== mapping.locale
        ? {
            type: "code_name_conflict",
            sourceAppCode,
            rawSourceLanguageCode: sourceLanguageCode,
            resolvedLocale: mapping.locale,
            evidence: mapping.evidence,
            codeLocale: mapping.locale,
            nameLocale,
            sourceLanguageCode,
            sourceLanguageName,
          }
        : null;

    return {
      sourceAppCode,
      sourceLanguageCode,
      locale: mapping.locale,
      confidence: "code",
      evidence: mapping.evidence,
      warning,
    };
  }

  if (nameLocale) {
    return {
      sourceAppCode,
      sourceLanguageCode,
      locale: nameLocale,
      confidence: "name_alias",
      evidence: "confirmed_name_alias",
      warning: null,
    };
  }

  return {
    sourceAppCode,
    sourceLanguageCode,
    locale: null,
    confidence: "unknown",
    evidence: "unknown",
    warning: null,
  };
}

/**
 * Circuit-breaker over a batch of resolutions. COPY of CPS
 * `evaluateLanguageMappingSuspensions` verbatim, including the exact
 * thresholds (`total>=10 && conflicts>=3 && conflictRate>=0.2`): a code
 * whose resolutions disagree with their own paired `languageName` often
 * enough in one batch is suspended for that batch — the caller must then
 * force `locale: null` for every resolution of that code, regardless of
 * what the code mapping said. This is the same data-quality safety net
 * CPS's `changdu-dry-run.ts` runs per upstream page fetch; this repo's
 * worker applies it at the same granularity (per `catalog_page` task item —
 * see `worker/handlers/moboreader.ts`).
 */
export function evaluateLanguageMappingSuspensions(
  resolutions: ReadonlyArray<{
    sourceLanguageCode: string;
    warning?: ChannelLanguageWarning | null;
  }>,
): Set<string> {
  const byCode = new Map<string, { total: number; conflicts: number }>();
  for (const resolution of resolutions) {
    const sourceLanguageCode = resolution.sourceLanguageCode.trim();
    if (!sourceLanguageCode) continue;
    const stats = byCode.get(sourceLanguageCode) ?? { total: 0, conflicts: 0 };
    stats.total += 1;
    if (resolution.warning?.type === "code_name_conflict") stats.conflicts += 1;
    byCode.set(sourceLanguageCode, stats);
  }

  const suspended = new Set<string>();
  for (const [sourceLanguageCode, stats] of byCode) {
    const conflictRate = stats.conflicts / stats.total;
    if (stats.total >= 10 && stats.conflicts >= 3 && conflictRate >= 0.2) {
      suspended.add(sourceLanguageCode);
    }
  }
  return suspended;
}
