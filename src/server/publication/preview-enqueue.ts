/** Post-commit preview planning. The Article's actual PromoLink is authoritative;
 * never borrow an arbitrary account or the last catalog scan's identity. */
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { enqueueMoboreaderPreviewRefreshTask, type MoboreaderPreviewTaskCreationResult } from "@/lib/tasks/moboreader";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { buildPublicArticleWhere, isPromoReady } from "./visibility";

export type PublicationPreviewInput = {
  articleIds: readonly string[];
  requestId: string;
  actorId: string;
};
export type PublicationPreviewResult = {
  skipReasonCounts: Record<string, number>;
  groups: Array<{ channelAccountId: string; channelAppId: string; result: MoboreaderPreviewTaskCreationResult }>;
};

export async function enqueuePublicationPreviews(
  db: PrismaClient,
  input: PublicationPreviewInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PublicationPreviewResult> {
  const result: PublicationPreviewResult = { skipReasonCounts: {}, groups: [] };
  const skip = (reason: string) => { result.skipReasonCounts[reason] = (result.skipReasonCounts[reason] ?? 0) + 1; };
  const ids = [...new Set(input.articleIds)];
  if (!ids.length) return result;
  const articles = await db.article.findMany({
    where: buildPublicArticleWhere({ id: { in: ids }, articleType: "novel_article", locale: { in: [...SITE_LOCALES] } }, env),
    select: { id: true, novelId: true, promoLink: { select: {
      status: true, webUrl: true, appUrl: true, deletedAt: true,
      channelAccountId: true, channelAppId: true, novelSourceItemId: true,
      novelSourceItem: { select: { novelId: true, channelAppId: true, deletedAt: true } },
    } } },
    orderBy: { id: "asc" },
  });
  result.skipReasonCounts.article_not_public = ids.length - articles.length;
  const groups = new Map<string, { channelAccountId: string; channelAppId: string; ids: Set<string> }>();
  const books = new Set<string>();
  for (const article of articles) {
    const promo = article.promoLink;
    if (!promo || promo.deletedAt || !isPromoReady(promo)) { skip("promo_not_ready"); continue; }
    if (!article.novelId || promo.novelSourceItem.deletedAt
      || promo.novelSourceItem.novelId !== article.novelId
      || promo.novelSourceItem.channelAppId !== promo.channelAppId) { skip("source_binding_invalid"); continue; }
    // Multiple locale articles for a book need only one materialization. A
    // stable article order chooses among their own valid PromoLinks.
    if (books.has(article.novelId)) { skip("duplicate_novel"); continue; }
    books.add(article.novelId);
    const key = `${promo.channelAccountId}:${promo.channelAppId}`;
    const group = groups.get(key) ?? { channelAccountId: promo.channelAccountId, channelAppId: promo.channelAppId, ids: new Set<string>() };
    group.ids.add(promo.novelSourceItemId);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    try {
      // A retried partially committed batch may publish a different subset.
      // Include that subset in the request identity; book locks still provide
      // cross-token and overlapping-scope deduplication.
      const token = createHash("sha256").update(JSON.stringify([input.requestId, key, [...group.ids].sort()])).digest("hex");
      // Separate from the already committed publish transaction. A SQL error
      // rolls back only this group, and other groups can still enqueue.
      const queued = await db.$transaction((tx) => enqueueMoboreaderPreviewRefreshTask(tx, {
        trigger: "auto", channelAccountId: group.channelAccountId, channelAppId: group.channelAppId,
        novelSourceItemIds: [...group.ids],
        requestToken: `publication-preview:${token}`, requestId: input.requestId,
        actorId: input.actorId, mode: "apply",
      }, env), { timeout: 30_000 });
      result.groups.push({ channelAccountId: group.channelAccountId, channelAppId: group.channelAppId, result: queued });
    } catch (error) {
      skip("enqueue_failed");
      const failure = error as { name?: string; code?: string };
      console.error("[PublicationDispatcher] preview enqueue failed after commit", {
        requestId: input.requestId, channelAccountId: group.channelAccountId,
        channelAppId: group.channelAppId, errorKind: failure?.name ?? "Error", code: failure?.code,
      });
    }
  }
  return result;
}
