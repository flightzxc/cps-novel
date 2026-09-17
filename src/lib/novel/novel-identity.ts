/**
 * C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §3.1 item 2). Verbatim
 * port of CPS `normalizeName` (`src/lib/drama-identity.ts`, 10 lines): NFKC
 * normalize, lower-case, strip quote characters, turn punctuation into
 * spaces, collapse whitespace. Feeds `Novel.titleNormalized`
 * (`novel.title_normalized`) — the physical column CPS's own
 * `Drama.nameNormalized` copied verbatim (see that column's own doc comment
 * in `prisma/schema.prisma`).
 *
 * Two write points must call this whenever `Novel.title` is set, per the
 * construction order's "漏一处配对静默失效" warning:
 *   1. Novel creation — `src/server/content-creation/service.ts`'s
 *      `runCreateTransaction` (`tx.novel.create`).
 *   2. A Novel title-update path.
 *
 * 🔴 As of this order, write point 2 does not exist anywhere in this
 * codebase — the only place `Novel` rows are ever created or have `title`
 * set is the single `tx.novel.create` call in
 * `src/server/content-creation/service.ts` (grepped: `\.novel\.(create|
 * update|updateMany|upsert)` across `src/`/`worker/`/`scheduler/`/`scripts/`
 * finds exactly one call that sets `title`; `publish-gate/service.ts`'s two
 * `novel.update(Many)` calls only ever write `status`). There is no
 * "edit Novel title" admin feature in this repository today. This function
 * is still added now (not deferred) because C-30B's batch bipartite pairing
 * needs `title_normalized` populated for every future Novel from day one; if
 * a Novel title-edit feature is ever added, it MUST call this function too —
 * per the construction order's explicit instruction, do not silently widen
 * this list without stopping to report it first.
 */
export function normalizeNovelTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛']/g, "")
    .replace(/[“”"]/g, "")
    .replace(/[\-–—_:,.!?()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
