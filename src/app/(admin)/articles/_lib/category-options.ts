import { projectAdminCanonicalTagList } from "@/contracts";
import { ADMIN_TAG_MAX_PAGE_SIZE } from "@/domain/tagging-admin";
import { listAdminCanonicalTags } from "@/server/tagging/admin-service";

import { prisma } from "../../../api/admin/_lib/deps";
import { readTaggingFlagState } from "../../tags/_lib/tagging-flag-checklist";

export type ArticleCategoryOption = Readonly<{ id: string; label: string }>;

/**
 * C-19 (分类 filter, item #10 ADAPT): the `/articles` category dropdown's
 * option list — every *active* Canonical Tag, id + a display label.
 *
 * Same "walk every page" technique as
 * `../../novels/_components/novel-tags-panel.tsx`'s
 * `listAllActiveCanonicalTags` (capped at 10 pages / 1000 tags as a runaway
 * guard — that file's own header notes the V1 taxonomy is already
 * bootstrap-frozen at 123 tags, past `listAdminCanonicalTags`'s own
 * `ADMIN_TAG_MAX_PAGE_SIZE` (100) single-page cap). Duplicated here rather
 * than imported — that helper is module-private inside a `novels`-scoped
 * component file, the same file-boundary discipline
 * `article-filters.tsx` already documents for not re-importing
 * `NOVEL_STATUS_BADGES`.
 *
 * Gated on `readTaggingFlagState().readEnabled` first, same precondition
 * `/categories` itself checks before ever calling `listAdminCanonicalTags`
 * (that service throws `TaggingAdminError("tagging_disabled", 403)`
 * otherwise) — an empty option list when the flag is off degrades the
 * dropdown to just "全部分类", not a page-wide failure.
 *
 * Label prefers the `zh` translation, falling back to `stableId` when there
 * is none. That is a deliberate departure from
 * `canonical-tags-client.tsx`'s `zhDisplayName` (which renders "—" and never
 * substitutes another string): a `<select>` option needs *some* visible,
 * distinguishing text, and `stableId` is exactly what `/categories` itself
 * shows next to a tag with no Chinese name.
 */
export async function listArticleCategoryOptions(): Promise<readonly ArticleCategoryOption[]> {
  if (!readTaggingFlagState().readEnabled) return [];
  const first = projectAdminCanonicalTagList(
    await listAdminCanonicalTags(prisma, { active: "active", pageSize: ADMIN_TAG_MAX_PAGE_SIZE }),
  );
  const items = [...first.items];
  const safeTotalPages = Math.min(first.totalPages, 10);
  for (let page = 2; page <= safeTotalPages; page += 1) {
    const next = projectAdminCanonicalTagList(
      await listAdminCanonicalTags(prisma, { active: "active", pageSize: ADMIN_TAG_MAX_PAGE_SIZE, page }),
    );
    items.push(...next.items);
  }
  return items.map((tag) => ({
    id: tag.id,
    label: tag.translations.find((translation) => translation.locale === "zh")?.displayName ?? tag.stableId,
  }));
}
