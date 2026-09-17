import type { PrismaClient } from "@prisma/client";

import type { NovelGenerateCandidate, NovelGeneratePage, PinnedNovelResult } from "@/domain/article-generation";
import {
  listNovelsForArticleGenerate,
  loadPinnedNovelForArticleGenerate,
} from "@/server/content-creation";

export type ArticleGeneratePageModel = {
  readonly pinned: PinnedNovelResult;
  readonly page: NovelGeneratePage;
};

export async function loadArticleGeneratePage(
  db: PrismaClient,
  query: { readonly novelId?: string; readonly search?: string; readonly locale?: string },
): Promise<ArticleGeneratePageModel> {
  const [pinned, page] = await Promise.all([
    loadPinnedNovelForArticleGenerate(db, query.novelId),
    listNovelsForArticleGenerate(db, {
      search: query.search,
      // This page's URL contract stays a single `?locale=` (no chip UI
      // here — see `batch-generate-form.tsx` for that); adapt to
      // `listNovelsForArticleGenerate`'s widened `locales` param at the
      // call site rather than changing this page's own query shape.
      locales: query.locale !== undefined ? [query.locale] : undefined,
      page: 1,
      pageSize: 80,
      eligibleOnly: false,
    }),
  ]);
  return { pinned, page };
}

export function selectedGenerateTarget(
  model: ArticleGeneratePageModel,
): NovelGenerateCandidate | null {
  return model.pinned.status === "found" ? model.pinned.novel : null;
}

export function pinnedGenerateError(pinned: PinnedNovelResult): string | null {
  if (pinned.status === "invalid") return "书目标识无效，不能改选其它书目。";
  if (pinned.status === "missing") return "指定书目不存在，不能改选其它书目。";
  if (pinned.status === "deleted") return "指定书目已删除，不能改选其它书目。";
  return null;
}
