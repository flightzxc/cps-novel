"use client";

import { useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import {
  TAG_LOCALE_LABELS,
  TAG_TRANSLATION_DEFAULT_EXPANDED,
  TAG_TRANSLATION_LOCALES,
} from "@/lib/locale/locale-canonical";

type TranslationRow = { locale: string; displayName: string };

const DEFAULT_EXPANDED: ReadonlySet<string> = new Set(TAG_TRANSLATION_DEFAULT_EXPANDED);

/**
 * Fixed-locale translation editor for `CanonicalTag`, ported from CPS's
 * `tags/_components/locale-field-editor.tsx` (`git show d77c3b9`) with one
 * structural change forced by the data shape: CPS edits a `Record<string,
 * string>` JSON blob directly, this edits a relational row array
 * (`{locale, displayName}[]`). So this component does the array↔map
 * conversion internally and stays array-in/array-out at the boundary —
 * `onChange` always hands back a `TranslationRow[]`, which is exactly what
 * `CanonicalTagEditor`'s `onReplaceTranslations(translations)` already
 * expects, so that callback's signature (and the parent
 * `canonical-tags-client.tsx`) needed zero changes.
 *
 * No free-text locale input anywhere: the only locales that can ever appear
 * are `TAG_TRANSLATION_LOCALES`, the project's single source of truth for
 * this domain (`src/lib/locale/locale-canonical.ts`). That is the entire
 * point of this component — the old `<input placeholder="locale">` let an
 * operator's typo silently create an orphan-locale translation with nothing
 * to catch it; a fixed list makes that class of mistake structurally
 * impossible.
 *
 * One deliberate divergence from the CPS reference: there, once `showAll`
 * flips true, `hiddenCount` recomputes against the now-fully-expanded view
 * and hits 0, which makes the toggle button's `hiddenCount > 0` guard hide
 * the button — so CPS's editor can expand but never collapses back via the
 * button. The brief for this change explicitly asks for "可再收起" (must be
 * able to re-collapse), so here `hiddenCount` is always computed from the
 * *collapsed* view, independent of the current `showAll` state, and the
 * button's visibility no longer depends on which state you're currently in.
 */
export function LocaleFieldEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: readonly TranslationRow[];
  onChange: (value: TranslationRow[]) => void;
  disabled?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);

  const displayNameByCode = new Map(value.map((row) => [row.locale, row.displayName]));

  // Computed against the collapsed view on purpose (see doc comment above):
  // this must stay stable regardless of `showAll` so the toggle button can
  // always flip back to "收起", not just to "展开全部".
  const collapsedLocales = TAG_TRANSLATION_LOCALES.filter(
    (locale) => DEFAULT_EXPANDED.has(locale) || displayNameByCode.has(locale),
  );
  const hiddenCount = TAG_TRANSLATION_LOCALES.length - collapsedLocales.length;
  const visibleLocales = showAll ? TAG_TRANSLATION_LOCALES : collapsedLocales;

  function handleChange(locale: string, nextValue: string) {
    const next = new Map(displayNameByCode);
    if (nextValue) {
      next.set(locale, nextValue);
    } else {
      // Empty value deletes the row instead of submitting
      // `displayName: ""` — `replace_translations` is a full replace, so an
      // empty-string placeholder row would persist as real (blank) data
      // rather than simply being absent.
      next.delete(locale);
    }
    // Rebuilt in `TAG_TRANSLATION_LOCALES` enumeration order (not Map
    // insertion order) so every save produces the same, deterministic
    // array shape for a given set of filled-in locales.
    onChange(
      TAG_TRANSLATION_LOCALES.filter((code) => next.has(code)).map((code) => ({
        locale: code,
        displayName: next.get(code) as string,
      })),
    );
  }

  return (
    <div className="space-y-1.5">
      {visibleLocales.map((locale) => (
        <div key={locale} className="flex items-center gap-2">
          <span className="w-14 shrink-0 font-mono text-xs text-gray-400">{locale}</span>
          <input
            type="text"
            value={displayNameByCode.get(locale) ?? ""}
            disabled={disabled}
            onChange={(event) => handleChange(locale, event.target.value)}
            placeholder={TAG_LOCALE_LABELS[locale]}
            aria-label={`译名 · ${locale}`}
            className="flex-1 rounded border border-gray-300 px-2 py-1 text-xs disabled:bg-gray-50 disabled:text-gray-400"
          />
        </div>
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((prev) => !prev)}
          className={buttonClassName("ghost", "px-2 py-1 text-xs")}
        >
          {showAll ? "收起" : `展开全部 ${hiddenCount} 种语言`}
        </button>
      )}
    </div>
  );
}
