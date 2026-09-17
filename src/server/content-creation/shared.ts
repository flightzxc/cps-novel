import { Prisma } from "@prisma/client";

import { isHealthySlug, textToSlug } from "@/lib/slug/text-to-slug";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { isUniqueConstraintViolation } from "@/lib/db/db-retry";
import { evaluateNovelMaterializationLocale } from "@/domain/novel-materialization-locale";

import { ContentCreationInputError, type CreateContentActor } from "./types";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SLUG_SUFFIX_MAX_ATTEMPTS = 200;
export const NOVEL_CREATE_AUDIT_ACTION = "novel.create";
export const ARTICLE_GENERATE_AUDIT_ACTION = "article.generate";

export function requireUuid(value: unknown, code: "invalid_novel_source_item_id" | "invalid_novel_id"): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ContentCreationInputError(
      code,
      code === "invalid_novel_id" ? "A valid Novel UUID is required" : "A valid NovelSourceItem UUID is required",
    );
  }
  return value.toLowerCase();
}

export function deriveLocale(sourceLocale: string | null): SiteLocale {
  const eligibility = evaluateNovelMaterializationLocale(sourceLocale);
  if (!eligibility.eligible && eligibility.code === "missing_locale") {
    throw new ContentCreationInputError(
      "missing_locale",
      "NovelSourceItem.sourceLocale is NULL/blank — cannot derive a content locale without human/vendor-code correction upstream",
    );
  }
  if (!eligibility.eligible) {
    throw new ContentCreationInputError(
      "unsupported_locale",
      `NovelSourceItem.sourceLocale "${sourceLocale}" resolved to a locale that is not a registered SiteLocale`,
    );
  }
  return eligibility.locale;
}

export function requireActor(actor: CreateContentActor): void {
  const id = actor.type === "admin" ? actor.adminId : actor.source;
  if (typeof id !== "string" || id.trim().length === 0 || id.length > 128) {
    throw new ContentCreationInputError("invalid_actor", "A valid actor identity is required");
  }
}

export function requireRequestId(requestId: unknown): string {
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 160) {
    throw new ContentCreationInputError("invalid_request_id", "A valid requestId is required");
  }
  return requestId;
}

export function auditActorType(actor: CreateContentActor): "admin" | "system" {
  return actor.type;
}

export function auditActorId(actor: CreateContentActor): string {
  return actor.type === "admin" ? actor.adminId : actor.source;
}

export type SlugConflictCheck = (candidateSlug: string) => Promise<boolean>;

export type SlugResolution =
  | { readonly outcome: "ok"; readonly slug: string; readonly baseSlug: string }
  | { readonly outcome: "slug_unhealthy"; readonly baseSlug: string }
  | { readonly outcome: "slug_conflict_exhausted"; readonly baseSlug: string };

type SlugResolutionOptions = Readonly<{
  validateHealth?: boolean;
}>;

export async function resolveUniqueSlug(
  title: string,
  locale: SiteLocale,
  exists: SlugConflictCheck,
  options: SlugResolutionOptions = {},
): Promise<SlugResolution> {
  const baseSlug = textToSlug(title, locale);
  if ((options.validateHealth ?? true) && !isHealthySlug(baseSlug)) {
    return { outcome: "slug_unhealthy", baseSlug };
  }
  if (!(await exists(baseSlug))) {
    return { outcome: "ok", slug: baseSlug, baseSlug };
  }
  for (let suffix = 2; suffix <= SLUG_SUFFIX_MAX_ATTEMPTS; suffix += 1) {
    const candidate = `${baseSlug}-${suffix}`;
    if (!(await exists(candidate))) {
      return { outcome: "ok", slug: candidate, baseSlug };
    }
  }
  return { outcome: "slug_conflict_exhausted", baseSlug };
}

export function existsCheck(
  find: (args: { where: { locale: string; slug: string; deletedAt: null }; select: { id: true } }) => Promise<{ id: string } | null>,
  locale: SiteLocale,
): SlugConflictCheck {
  return async (candidate) => (await find({ where: { locale, slug: candidate, deletedAt: null }, select: { id: true } })) !== null;
}

export function uniqueTargetText(error: unknown): string {
  if (!isUniqueConstraintViolation(error) || !(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return "";
  }
  const target = error.meta?.target;
  return Array.isArray(target) ? target.join(",") : String(target ?? "");
}

export function isArticleNovelLocaleUniqueViolation(error: unknown): boolean {
  const target = uniqueTargetText(error).toLowerCase();
  return (
    target.includes("article_novel_locale_key") ||
    (target.includes("novel_id") && target.includes("locale")) ||
    (target.includes("novelid") && target.includes("locale"))
  );
}
