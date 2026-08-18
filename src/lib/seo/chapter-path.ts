import {
  buildArticlePath,
  buildArticleRoutePath,
  type ArticlePathInput,
  type ArticleRoutePathInput,
} from "@/lib/slug/article-path";

/**
 * Chapter URL composer. Does not edit `article-path.ts` (frozen D-8 builder);
 * appends `/chapter/{n}` onto the Article path.
 */

export function buildChapterRoutePath(
  input: ArticleRoutePathInput & { chapterNumber: number },
): string {
  return `${buildArticleRoutePath(input)}/chapter/${input.chapterNumber}`;
}

export function buildChapterPath(input: ArticlePathInput & { chapterNumber: number }): string {
  return `${buildArticlePath(input)}/chapter/${input.chapterNumber}`;
}
