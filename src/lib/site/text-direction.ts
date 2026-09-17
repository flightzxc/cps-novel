/**
 * Text direction (LTR/RTL) determination for `<html dir>`.
 *
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.2): ported from CPS
 * `src/lib/locale-direction.ts`'s public `getTextDirection` helper — same
 * regex, same semantics (`ar`/`fa`/`he`/`ur`, including any region variant
 * such as `ar-EG`, are `rtl`; everything else is `ltr`).
 *
 * 🔴 This is the site's SOLE direction-determination implementation. CPS's
 * own codebase has this exact rule implemented three separate times (a
 * shared helper nobody calls, a private copy inside one component, and a
 * third inline `lang === "ar" ? "rtl" : "ltr"` form in its root layout —
 * see this work order's §8.2 for the full account). `src/app/layout.tsx`
 * is the only caller here; if a second caller ever needs this, it must
 * import this function rather than re-deriving the rule.
 */
export function getTextDirection(locale: string): "rtl" | "ltr" {
  return /^(ar|fa|he|ur)(-|$)/i.test(locale) ? "rtl" : "ltr";
}
