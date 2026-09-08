"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { requireAdminActionAccess } from "@/server/auth/guards";
import {
  ArticleConflictError,
  regenerateArticle,
  regenerateArticlesBatch,
  updateArticleContent,
  type ArticleEditInput,
} from "@/server/articles";
import {
  publishArticleAsAdmin,
  publishArticlesBatchAsAdmin,
  withdrawNovel,
  PublishLifecycleError,
  type ApplyPublishTransitionResult,
  type PublishArticlesBatchResult,
  type RightsTransitionResult,
} from "@/server/publish-gate";

import { canonicalOrigin, guardDependencies, prisma, readSessionToken } from "../../api/admin/_lib/deps";

/**
 * C-21 (`分析_文章管理Parity缺口_2026-09-08.md` §六): thin Server Action
 * wrappers around the already-gated publish-gate primitives
 * (`@/server/publish-gate`) — the same functions `../novels/_actions.ts`
 * already wires for the novel-detail lifecycle panel and the `/novels` list's
 * batch-publish toolbar. This file adds no new way to write
 * `Article.status`/`Novel.status`; it only widens `revalidatePath` to cover
 * `/articles` (the novels wrappers only revalidate `/novels*`, so a
 * publish/withdraw triggered from this list would otherwise leave the
 * article list showing a stale row) — see `tests/backend/publish-gate/
 * no-bypass.test.ts`, which statically forbids a second write path and stays
 * green because this module never touches `article`/`novel` status itself.
 *
 * `authorization()`'s `actionId` type below was widened from
 * `` `admin.article.${string}` `` to `` `admin.${string}` `` (matching
 * `../novels/_actions.ts`'s own `authorize()`) because `withdrawArticleAction`
 * requests `"admin.novel.withdraw"` — the row-level "下线" ADAPT (analysis
 * doc item #25) is a Novel-status rights transition (`withdrawNovel`), not an
 * Article-only endpoint; see that function's own doc comment below for why.
 */
async function authorization(actionId: `admin.${string}`, requestId: string) {
  const requestHeaders = await headers();
  const access = await requireAdminActionAccess({ actionId, sessionToken: await readSessionToken(), origin: requestHeaders.get("origin"), canonicalOrigin: await canonicalOrigin(), requestId }, guardDependencies());
  if (!access.serviceAuthorization) throw new Error("authorization_required");
  return access.serviceAuthorization;
}

function deps() {
  const guards = guardDependencies();
  return { db: prisma, identities: guards.identities, sessions: guards.sessions };
}

/**
 * N-7: `article_conflict` is the one error the UI must tell apart from every
 * other write failure (it means "reload and re-apply your edit", not "retry
 * the same request"). Everything else stays the pre-existing opaque
 * `*_failed` code. `article_conflict` is registered in `src/contracts/errors.ts`
 * (`AdminErrorCode`) and `src/features/admin-ui/error-copy.ts` — see
 * `ArticleConflictError`'s doc comment (`src/server/articles/service.ts`) for
 * why there is no `respond.ts` entry to add alongside them.
 *
 * C-21 extends this with `PublishLifecycleError` (`@/server/publish-gate`):
 * its `code` union (`novel_not_found`, `novel_not_currently_published`,
 * `batch_too_large`, …) is already operator-meaningful on its own, so it is
 * forwarded the same way `ArticleConflictError`'s code already is, instead of
 * collapsing to the generic fallback. This function itself returns a bare
 * `string` — it cannot know at this layer which of those two families (or
 * the plain opaque `*_failed` fallback) a given code came from — so the
 * actual Chinese-copy mapping is the caller's job:
 * `../articles/_components/article-list.tsx` runs every `code` it gets back
 * through `../novels/_lib/publish-outcome-copy.ts`'s
 * `isPublishLifecycleErrorCode` guard before calling
 * `describePublishLifecycleError`, and falls back to rendering the raw code
 * only for the two families that guard can't (and isn't meant to) translate:
 * `article_conflict` and the opaque `*_failed` codes above.
 */
function writeErrorCode(error: unknown, fallback: string): string {
  if (error instanceof ArticleConflictError) return error.code;
  if (error instanceof PublishLifecycleError) return error.code;
  return fallback;
}

export async function updateArticleAction(input: { requestId: string; articleId: string; expectedUpdatedAt: string; patch: ArticleEditInput }) {
  try {
    const auth = await authorization("admin.article.update", input.requestId);
    await updateArticleContent({ authorization: auth, ...input }, deps());
    revalidatePath("/articles");
    revalidatePath(`/articles/${input.articleId}`);
    return { ok: true as const };
  } catch (error) { return { ok: false as const, code: writeErrorCode(error, "article_update_failed") }; }
}

export async function regenerateArticleAction(input: { requestId: string; articleId: string; expectedUpdatedAt: string }) {
  try {
    const auth = await authorization("admin.article.regenerate", input.requestId);
    const data = await regenerateArticle({ authorization: auth, ...input }, deps());
    revalidatePath("/articles");
    return { ok: true as const, data };
  } catch (error) { return { ok: false as const, code: writeErrorCode(error, "article_regenerate_failed") }; }
}

export async function regenerateArticlesBatchAction(input: { requestId: string; articleIds: readonly string[] }) {
  try {
    const auth = await authorization("admin.article.regenerate_batch", input.requestId);
    const data = await regenerateArticlesBatch({ authorization: auth, ...input }, deps());
    revalidatePath("/articles");
    return { ok: true as const, data };
  } catch { return { ok: false as const, code: "article_batch_regenerate_failed" }; }
}

/**
 * C-21 row-level "发布" (analysis doc item #24, ADAPT): the article list's
 * draft-row publish button. `entryId`/`actionId` is the literal
 * `publishArticleAsAdmin` hardcodes internally
 * (`src/server/publish-gate/service.ts`) — same registry entry
 * `../novels/_actions.ts`'s `publishArticleAction` already uses
 * (`P2_04_ADMIN_REGISTRY`'s `"admin.article.publish"`), just re-requested
 * from this route so the resulting ticket's entryId check passes.
 *
 * Deliberately article-keyed only (no `novelId` in the input): unlike
 * `withdrawArticleAction` below, `publishArticleAsAdmin` needs nothing but
 * the `articleId` this list already has as its row key.
 */
export async function publishArticleAction(input: { requestId: string; articleId: string }) {
  try {
    const auth = await authorization("admin.article.publish", input.requestId);
    const data: ApplyPublishTransitionResult = await publishArticleAsAdmin(
      { authorization: auth, requestId: input.requestId, articleId: input.articleId },
      deps(),
    );
    revalidatePath("/articles");
    return { ok: true as const, data };
  } catch (error) { return { ok: false as const, code: writeErrorCode(error, "article_publish_failed") }; }
}

/**
 * C-21 row-level "下线" (analysis doc item #25, ADAPT — "隐藏"/"下线", not SEO
 * visibility; see the doc's §零 correction). There is no Article-only
 * offline endpoint: today's one-Article-per-Novel shape means the gated
 * primitive for this is `withdrawNovel` (`@/server/publish-gate`), a
 * Novel-status rights transition that cascades to every currently-`published`
 * Article under that Novel — exactly the "此篇下线" the operator asked for,
 * reached the same ADAPTed way `../novels/_components/publish-lifecycle-panel.tsx`
 * already reaches it for the novel-detail page's own "下架" button. This is
 * why the caller must pass `novelId` (from the row's `novel` field, C-20),
 * not just `articleId`.
 *
 * The reason is required (audited) — `withdrawNovel`'s own `trimmedReason`
 * throws a bare `Error` for a blank one, which is why the client component
 * disables the confirm button on an empty reason rather than relying on this
 * action to reject it with readable copy (see `article-list.tsx`).
 */
export async function withdrawArticleAction(input: { requestId: string; novelId: string; reason: string }) {
  try {
    const auth = await authorization("admin.novel.withdraw", input.requestId);
    const data: RightsTransitionResult = await withdrawNovel(
      { authorization: auth, requestId: input.requestId, novelId: input.novelId, reason: input.reason },
      deps(),
    );
    revalidatePath("/articles");
    revalidatePath(`/novels/${input.novelId}`);
    return { ok: true as const, data };
  } catch (error) { return { ok: false as const, code: writeErrorCode(error, "article_withdraw_failed") }; }
}

/**
 * C-21 list-level "批量发布" (analysis doc item #28, ADAPT — publish only;
 * batch withdraw/delete are explicitly excluded). Article-keyed directly —
 * unlike `../novels/_actions.ts`'s `publishNovelsBatchAction`, this list's
 * checkboxes already select `articleId`s, so there is no
 * `readPrimaryArticlesForNovels` novelId→articleId resolution step to redo.
 * The selection-size cap is enforced by `publishArticlesBatchAsAdmin`
 * (`PublishLifecycleError("batch_too_large", …)`, 200 — mirrored client-side
 * by `../novels/_lib/batch-publish-constants.ts`'s
 * `MAX_BATCH_PUBLISH_SELECTION`, reused as-is per the analysis doc's "批量发布
 * 复用书目列表已有的批量上限常量" rather than inventing a second constant).
 *
 * Fix 4 (Opus review of C-21/22/23): mirrors `publishNovelsBatchAction`'s own
 * `Array.from(new Set(...))` dedupe and empty-selection rejection —
 * `selected` is a `Set` in `article-list.tsx` so a duplicate id should never
 * reach this action in practice, but this action has no other caller-side
 * guarantee of that, and a duplicate id would otherwise make
 * `publishArticlesBatch`'s per-id loop apply the same publish transition
 * twice (each iteration idempotent on its own, but doubling the batch's
 * effective size against the `batch_too_large` cap for no operator-visible
 * reason). The empty-selection check runs before `authorization()` for the
 * same reason `runNovelAction`'s `validate` callback does in
 * `../novels/_actions.ts`: a request that was never going to do anything
 * should not spend the per-action rate-limit allowance or the `requestId`
 * idempotency key first.
 */
export async function publishArticlesBatchAction(input: { requestId: string; articleIds: readonly string[] }) {
  const articleIds = Array.from(new Set(input.articleIds));
  if (articleIds.length === 0) return { ok: false as const, code: "selection_required" };
  try {
    const auth = await authorization("admin.article.publish_batch", input.requestId);
    const data: PublishArticlesBatchResult = await publishArticlesBatchAsAdmin(
      { authorization: auth, requestId: input.requestId, articleIds },
      deps(),
    );
    revalidatePath("/articles");
    return { ok: true as const, data };
  } catch (error) { return { ok: false as const, code: writeErrorCode(error, "article_batch_publish_failed") }; }
}
