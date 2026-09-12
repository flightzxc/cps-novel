/**
 * C-30 types-only re-export of `@/server/article-rebind`'s public shapes, so
 * Client Components under `../` can name these types without importing
 * `@/server/article-rebind` directly — `tests/ui/admin-secret-boundary.test.tsx`'s
 * "keeps Client Components away from Prisma and server services" check
 * forbids ANY `"use client"` file from writing `from "@/server/..."`, type-only
 * imports included (see that test's own comment on the regex being
 * deliberately blind to `import type`).
 *
 * This module used to be a bare `export type { … };` re-export list living
 * at the top of `../_actions.ts` (a `"use server"` file). That shape is what
 * broke every Server Action in this route: Next's `"use server"` export
 * transform does not recognize a name-only `export type { A, B };` /
 * `export type { A } from "…";` re-export list as fully type-only, and emits
 * a runtime reference to each listed name expecting it to be a server
 * action — but the names were only ever type imports, erased by the
 * ordinary TypeScript/SWC type-stripping pass, so nothing was left to
 * reference. That produced `ReferenceError: RebindBatchDetail is not
 * defined at module evaluation` in every `_actions.ts` chunk (X8 web log,
 * 35 occurrences), which crashed the whole module — including the actual
 * async Server Actions in the same file — the instant anything imported it.
 * A plain type alias declaration (`export type Foo = …;`) does not trigger
 * this: it is a single self-contained AST node that vanishes entirely once
 * stripped, with no leftover bare identifier for the transform to trip over
 * — confirmed by building this repo before this fix and diffing the
 * compiled `.next/server/chunks/ssr/…` output (see this fix's own commit
 * for the before/after `grep -c` counts). Moving the re-export list to a
 * plain module with neither a `"use server"` nor `"use client"` directive
 * sidesteps the transform entirely: this file is never treated as a Server
 * Actions module, so nothing here is fed through that export-instrumentation
 * pass, and the re-exported names are erased as ordinary type-only exports
 * the same way any other `.ts` type barrel would be.
 *
 * `../_actions.ts` keeps its own `import { …, type X, … } from
 * "@/server/article-rebind"` for the type annotations it still needs
 * internally — those are never re-exported from that file, so they stay
 * inert type-only imports and never reach the transform's export scan.
 */
export type {
  RebindBatchDetail,
  RebindBatchFacets,
  RebindBatchSummary,
  RebindCandidate,
  RebindGuardFinding,
  RebindPreviewCategory,
  RebindPreviewPage,
  RebindView,
} from "@/server/article-rebind";
