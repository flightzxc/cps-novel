"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { requireAdminActionAccess } from "@/server/auth/guards";
import { regenerateArticle, regenerateArticlesBatch, updateArticleContent, type ArticleEditInput } from "@/server/articles";

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

export async function updateArticleAction(input: { requestId: string; articleId: string; patch: ArticleEditInput }) {
  try {
    const auth = await authorization("admin.article.update", input.requestId);
    await updateArticleContent({ authorization: auth, ...input }, deps());
    revalidatePath("/articles");
    revalidatePath(`/articles/${input.articleId}`);
    return { ok: true as const };
  } catch { return { ok: false as const, code: "article_update_failed" }; }
}

export async function regenerateArticleAction(input: { requestId: string; articleId: string }) {
  try {
    const auth = await authorization("admin.article.regenerate", input.requestId);
    const data = await regenerateArticle({ authorization: auth, ...input }, deps());
    revalidatePath("/articles");
    return { ok: true as const, data };
  } catch { return { ok: false as const, code: "article_regenerate_failed" }; }
}

export async function regenerateArticlesBatchAction(input: { requestId: string; articleIds: readonly string[] }) {
  try {
    const auth = await authorization("admin.article.regenerate_batch", input.requestId);
    const data = await regenerateArticlesBatch({ authorization: auth, ...input }, deps());
    revalidatePath("/articles");
    return { ok: true as const, data };
  } catch { return { ok: false as const, code: "article_batch_regenerate_failed" }; }
}
