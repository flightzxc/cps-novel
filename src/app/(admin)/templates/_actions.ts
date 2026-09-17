"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { requireAdminActionAccess } from "@/server/auth/guards";
import {
  ArticleTemplateInputError,
  createArticleTemplate,
  setArticleTemplateStatus,
  softDeleteArticleTemplate,
  updateArticleTemplate,
  type ArticleTemplateStatus,
  type ArticleTemplateWrite,
} from "@/server/article-templates";

import { canonicalOrigin, guardDependencies, prisma, readSessionToken } from "../../api/admin/_lib/deps";

export type TemplateActionResult = { ok: true } | { ok: false; code: string };

async function authorize(actionId: `admin.article_template.${string}`, requestId: string) {
  const requestHeaders = await headers();
  return requireAdminActionAccess({
    actionId,
    sessionToken: await readSessionToken(),
    origin: requestHeaders.get("origin"),
    canonicalOrigin: await canonicalOrigin(),
    requestId,
  }, guardDependencies());
}

function deps() {
  const guards = guardDependencies();
  return { db: prisma, identities: guards.identities, sessions: guards.sessions };
}

async function run(action: () => Promise<unknown>): Promise<TemplateActionResult> {
  try {
    await action();
    revalidatePath("/templates");
    revalidatePath("/catalog-sync");
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error instanceof ArticleTemplateInputError ? error.code : "template_write_failed" };
  }
}

export async function createTemplateAction(input: { requestId: string; template: ArticleTemplateWrite }) {
  return run(async () => {
    const { serviceAuthorization } = await authorize("admin.article_template.create", input.requestId);
    if (!serviceAuthorization) throw new ArticleTemplateInputError("authorization_required");
    await createArticleTemplate({ authorization: serviceAuthorization, ...input }, deps());
  });
}

export async function updateTemplateAction(input: { requestId: string; id: string; template: ArticleTemplateWrite }) {
  return run(async () => {
    const { serviceAuthorization } = await authorize("admin.article_template.update", input.requestId);
    if (!serviceAuthorization) throw new ArticleTemplateInputError("authorization_required");
    await updateArticleTemplate({ authorization: serviceAuthorization, ...input }, deps());
  });
}

export async function setTemplateStatusAction(input: { requestId: string; id: string; status: ArticleTemplateStatus }) {
  return run(async () => {
    const { serviceAuthorization } = await authorize("admin.article_template.status", input.requestId);
    if (!serviceAuthorization) throw new ArticleTemplateInputError("authorization_required");
    await setArticleTemplateStatus({ authorization: serviceAuthorization, ...input }, deps());
  });
}

export async function deleteTemplateAction(input: { requestId: string; id: string }) {
  return run(async () => {
    const { serviceAuthorization } = await authorize("admin.article_template.delete", input.requestId);
    if (!serviceAuthorization) throw new ArticleTemplateInputError("authorization_required");
    await softDeleteArticleTemplate({ authorization: serviceAuthorization, ...input }, deps());
  });
}
