/**
 * C-30 companion fix: `../_actions.ts` re-exported these same three
 * `@/server/publish-gate` types via a bare `export type { … };` list at its
 * former line 42. That is the identical shape that broke every Server
 * Action in `src/app/(admin)/articles/_actions.ts` (see
 * `../../articles/_types/rebind.ts`'s header for the full mechanism): a
 * name-only `export type { A, B, C };` re-export list in a `"use server"`
 * file is not recognized as fully type-only by Next's Server Actions export
 * transform, which emits a runtime reference to each listed name — but the
 * names were only ever type imports, erased by ordinary type-stripping, so
 * nothing existed to reference. Confirmed by build: before this fix,
 * `RightsTransitionResult` appeared as a bare, undeclared identifier inside
 * this route's `ensureServerEntryExports([...])` call in the compiled SSR
 * chunk, exactly like `RebindBatchDetail` did for `/articles` — meaning
 * every `/novels` Server Action was one evaluation away from the same
 * `ReferenceError`, not just `/articles`'s.
 *
 * `PublishActionResult<T>` and `PublishLifecycleErrorCode` are NOT moved
 * here: both are fresh `export type X = …;` alias declarations declared
 * directly in `../_actions.ts` (not a re-export list), which is the shape
 * that compiles away cleanly with no runtime remnant — confirmed by the
 * same before-fix build never referencing either name in the chunk's
 * `ensureServerEntryExports([...])` list. Only the re-export **list** form
 * is unsafe in a `"use server"` file; a plain type alias is not.
 */
export type {
  ApplyPublishTransitionResult,
  RightsTransitionKind,
  RightsTransitionResult,
} from "@/server/publish-gate";
