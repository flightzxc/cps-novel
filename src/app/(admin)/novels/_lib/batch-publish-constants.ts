/**
 * Mirrors `src/server/publish-gate/service.ts`'s own `MAX_BATCH_SIZE`, which
 * that module does not export (it is a private `const`, and
 * `publishArticlesBatch` is the sole enforcement point — see
 * `PublishLifecycleError`'s `batch_too_large` code). This is a UI-side early
 * warning only, not the enforcement: even if this constant ever drifted from
 * the service's real cap, `publishArticlesBatchAsAdmin` still throws
 * `PublishLifecycleError("batch_too_large", ...)` server-side and
 * `../_actions.ts`'s `lifecycle_error` branch still reports it correctly.
 * Kept in sync deliberately; `tests/ui/novel-publish-actions.test.ts` pins
 * this value.
 *
 * Lives in its own module, separate from `../_actions.ts`, because a
 * `"use server"` file may only export async functions (plus type-only
 * exports, which erase at build time) — Turbopack hard-fails the whole
 * module ("Only async functions are allowed to be exported in a 'use
 * server' file") on a plain `export const`. `./novels-batch-publish.tsx`
 * (a `"use client"` component) needs this value at render time to disable
 * the submit button and show the cap warning, so it cannot be type-only
 * either.
 */
export const MAX_BATCH_PUBLISH_SELECTION = 200;
