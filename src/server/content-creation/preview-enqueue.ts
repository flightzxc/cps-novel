/**
 * CPS v8.3.6 parity anchor: `changdu-preview-catalog-enqueue.ts` keeps
 * preview enqueueing idempotent and post-commit. Novel reuses the existing
 * Moboreader task factory; this module only resolves the account and maps the
 * result back to the content-creation UI.
 */
import type { PrismaClient } from "@prisma/client";

import {
  enqueueMoboreaderPreviewRefreshTask,
  type MoboreaderPreviewTaskCreationResult,
} from "@/lib/tasks/moboreader";

export type ContentCreationPreviewEnqueueResult =
  | ({ readonly queued: true } & Exclude<MoboreaderPreviewTaskCreationResult, { status: "no_eligible_sources" }>)
  | {
      readonly queued: false;
      readonly reason: "no_channel_account" | "mixed_channel_apps" | "enqueue_failed" | "no_eligible_sources";
      readonly skipReasonCounts?: Record<string, number>;
    };

export async function enqueueContentCreationPreview(
  db: PrismaClient,
  input: {
    readonly novelSourceItemIds: readonly string[];
    readonly requestToken: string;
    readonly requestId: string;
    readonly actorId: string;
  },
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<ContentCreationPreviewEnqueueResult> {
  // Lightweight fakes used by the existing content-creation unit suite do
  // not model catalog/account tables. Treat that exactly like an unavailable
  // account; production Prisma always has these delegates.
  if (!("catalogScanTask" in db) || !("channelAccount" in db)) {
    return { queued: false, reason: "no_channel_account" };
  }

  const sourceItems = await db.novelSourceItem.findMany({
    where: { id: { in: Array.from(new Set(input.novelSourceItemIds)) } },
    select: { id: true, channelAppId: true },
  });
  const channelAppIds = Array.from(new Set(sourceItems.map((item) => item.channelAppId)));
  if (channelAppIds.length !== 1) {
    return {
      queued: false,
      reason: channelAppIds.length > 1 ? "mixed_channel_apps" : "no_channel_account",
    };
  }
  const channelAppId = channelAppIds[0]!;

  const latestScan = await db.catalogScanTask.findFirst({
    where: { channelAppId, status: "completed" },
    select: { channelAccountId: true },
    orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
  });
  let channelAccountId = latestScan?.channelAccountId ?? null;

  if (!channelAccountId) {
    const accounts = await db.channelAccount.findMany({
      where: {
        status: "active",
        deletedAt: null,
        channel: { channelApps: { some: { id: channelAppId, status: "active" } } },
        credentials: {
          some: {
            status: "active",
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
        },
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
    if (accounts.length !== 1) return { queued: false, reason: "no_channel_account" };
    channelAccountId = accounts[0]!.id;
  }

  try {
    const result = await db.$transaction((tx) =>
      enqueueMoboreaderPreviewRefreshTask(
        tx,
        {
          trigger: "auto",
          channelAccountId,
          channelAppId,
          novelSourceItemIds: sourceItems.map((item) => item.id),
          requestToken: input.requestToken,
          requestId: input.requestId,
          actorId: input.actorId,
          mode: "apply",
        },
        env,
        now,
      ),
    );
    if (result.status === "no_eligible_sources") {
      return { queued: false, reason: "no_eligible_sources", skipReasonCounts: result.skipReasonCounts };
    }
    return { queued: true, ...result };
  } catch (error) {
    console.error("[content-creation] preview enqueue failed after commit", {
      requestId: input.requestId,
      error: error instanceof Error ? error.name : "unknown_error",
    });
    return { queued: false, reason: "enqueue_failed" };
  }
}
