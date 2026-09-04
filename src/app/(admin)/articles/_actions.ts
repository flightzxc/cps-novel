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

import { canonicalOrigin, guardDependencies, prisma, readSessionToken } from "../../api/admin/_lib/deps";

async function authorization(actionId: `admin.article.${string}`, requestId: string) {
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
 */
function writeErrorCode(error: unknown, fallback: string): string {
  return error instanceof ArticleConflictError ? error.code : fallback;
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
