/**
 * L10N P4: the `unstable_cache` tag name for the dynamic locale layer
 * (`./active-locales.ts`), split into its own zero-dependency module.
 *
 * `src/server/publication/revalidate.ts` needs only this string literal to
 * call `revalidateTag(ACTIVE_LOCALES_CACHE_TAG, { expire: 0 })` — it must NOT import
 * it from `./active-locales.ts` directly, because that module calls
 * `unstable_cache(...)` at module-eval time (`export const getActiveLocales
 * = unstable_cache(...)`), which throws in any test that mocks `next/cache`
 * without an `unstable_cache` export (several existing test files mock
 * `next/cache` for `revalidatePath`/`revalidateTag` alone, unaware that
 * importing `revalidate.ts` could transitively drag in a Prisma-backed
 * `unstable_cache` call). Keeping the tag name here, with no other exports
 * and no side effects, breaks that transitive coupling entirely.
 */
export const ACTIVE_LOCALES_CACHE_TAG = "active-locales";
