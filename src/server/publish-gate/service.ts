/**
 * The unified publish-gate write path (P2-07).
 *
 * `P2-07-12-移植审计-2026-08-12/P2-07.md` §headline documents three CPS defects
 * this module exists to make structurally impossible in this codebase:
 *
 *   1. The same admission check copy-pasted across every write path instead
 *      of living in one place (`drama-publish-actions.ts:110-114`,
 *      `article-actions.ts:563-567`, `batch-actions-core.ts:188-197`).
 *   2. Three *other* write paths that flip `status` straight to `published`
 *      with zero checks (`changeArticleStatus`/`changeArticlesStatus`/
 *      `changeArticlesStatusByFilter`, `article-actions.ts:1470-1684`) —
 *      reachable straight from the UI.
 *   3. A cron flip (`instrumentation.ts:18-72`) that never rechecks anything
 *      at the moment it actually publishes.
 *
 * The fix is structural, not a checklist: **`applyPublishTransition` below is
 * the only function anywhere in this codebase that may write
 * `Article.status = "published"` or `Novel.status = "published"`.**
 * `tests/backend/publish-gate/no-bypass.test.ts` statically scans `src/`,
 * `worker/`, `scheduler/`, and `scripts/` for any other Prisma model-delegate
 * write on `article`/`novel` (`update`/`updateMany`/`create`/`upsert`/...,
 * literal or variable `status:` values alike) or raw-SQL call mentioning an
 * article/novel status, and fails if one appears outside this directory —
 * see that test file's header for the exact, non-overclaimed scope (a source
 * scan narrows the search space, it does not prove no bypass exists by
 * construction). Every other way `published` could ever be reached —
 * interactive admin action, batch action, and the scheduled-publish sweep a
 * future cron/worker calls — is a thin wrapper around this one function, so
 * there is no second, unchecked path the way CPS's three `updateMany` call
 * sites and its cron were. This directly satisfies
 * `docs/p2/P2_01_PUBLISH_GATE_CONTRACT.md` §0 决策 6: "进入 published 的每一次
 * 转换都必须过同一个 gate，包括到点自动发布."
 *
 * ## Why Novel and Article publish together
 *
 * `visibility.ts`'s `isPublicationStatePublic` requires *both*
 * `Novel.status === "published"` and `Article.status === "published"`.
 * `Article` is a locale page snapshot of `Novel`
 * (`docs/governance/database-governance.md` §4) and today there is exactly
 * one Article per Novel (`SITE_LOCALES` has one member) — so "publish the
 * page" and "publish the work" are the same admin action in V1. This module
 * gates once and writes both sides in the same transaction. A future
 * multi-locale world, where a Novel could have several Articles publishing
 * on independent schedules, only needs `Novel.status` promotion to become
 * conditional ("promote only if this is that Novel's first Article to
 * publish"); nothing here assumes there is only ever one Article, but this
 * PR does not need to solve that because there is only one today.
 *
 * ## TOCTOU: the gate's read and its write live in the same transaction
 *
 * An earlier revision of this function loaded `PublishGateFacts` and
 * evaluated the gate against the top-level `db` handle, *before* opening the
 * transaction that wrote `published`. That left a window — between the read
 * and the write — where a concurrent `takedownNovel` could commit (deleting
 * `NovelChapterContent`, flipping `Novel`/`Article` to `takedown`) and then
 * be silently overwritten by this function's unconditional
 * `UPDATE ... SET status = 'published'`, republishing content whose body no
 * longer exists. A merge-time review (`scratchpad/reports/A-REVIEW.md` 必改
 * 1) reproduced this interleaving and it is exactly the class of defect this
 * module exists to make structurally impossible.
 *
 * The fix, below: `loadPublishGateFacts` and `evaluatePublishGate` both run
 * *inside* `db.$transaction`, against the transaction's own `tx` handle —
 * and the write itself is a conditional `updateMany` whose `WHERE` clause
 * pins `status` to the exact value this same transaction just read. If a
 * concurrent transaction changed that status in between (PostgreSQL's
 * default READ COMMITTED gives each statement a fresh read, not a stable
 * snapshot for the whole transaction, so moving the read inside the
 * transaction alone would not have been sufficient), `count` comes back `0`
 * and this function returns `{ outcome: "conflict" }` instead of writing —
 * never a silent publish over interference. `docs/governance/
 * database-governance.md` §6 documents the same "conditional UPDATE, not
 * read-then-unconditional-write" pattern for the canonical-fill contract;
 * this is that same discipline applied here.
 *
 * ## Restrictions vs. admissions
 *
 * `withdrawNovel`/`takedownNovel`/`restoreNovel` are restrictions/reversals,
 * not admissions — CPS's `offlineDrama`/`takedownDrama`/`restoreDrama`
 * orchestration skeleton (`drama-publish-actions.ts:294-486`, ~190 lines,
 * `P2-07.md` §C, COPY_THEN_ADAPT ~55%) never gated these either, and that is
 * correct: taking something offline or down needs no admission check, only
 * `publish` does. The one place this module intentionally departs from CPS:
 * `restoreDrama` could restore straight back to whatever status preceded
 * `offline`/`takedown`, including `published`, without re-running any gate.
 * That is a `MANUAL_EXCEPTION` in disguise, and
 * `docs/p2/P2_01_PUBLISH_GATE_CONTRACT.md` §0 决策 4 freezes "P2 V1 无
 * MANUAL_EXCEPTION". `restoreNovel` therefore always lands on `draft` —
 * getting back to `published` means going through `applyPublishTransition`
 * again, gate and all.
 *
 * ## What this module does not do
 *
 * It does not call `revalidatePath`/`revalidateTag` — that wiring is
 * Stream C's job (`P2_07_12_一轮实施分工方案_2026-08-12.md` §三 Stream C: "A 写口
 * 定型后接线"), deliberately sequenced after this module's write-path shape
 * is stable. It does not build Server Action / Admin UI wiring for these
 * functions — no admin screen calls them yet (`grep -rl publish
 * src/app/\(admin\)` turns up nothing but a status-badge label), so wiring a
 * Server Action now would be untested, unreachable code; the shape here
 * (`{ authorization: AdminServiceAuthorization, entryId, requestId, ... }`)
 * is the exact shape `src/server/credentials/service.ts`'s
 * `setChannelAccountStatus` already uses, so adding that Server Action is a
 * ~15-line follow-up once an admin screen needs it, following
 * `src/app/(admin)/channel-accounts/_actions.ts` as the template.
 */
import type { PrismaClient } from "@prisma/client";

import type { AdminIdentityStore, SessionStore } from "@/lib/auth/ports";
import type { NovelStatus } from "@/domain/database-statuses";
import { dispatchFirstPublicPublication } from "@/server/publication/dispatcher";
import { requireFreshAdminServiceMutation, type AdminServiceAuthorization } from "@/server/auth/guards";

import { evaluatePublishGate, type PublishGateEvaluation } from "./evaluator";
import { loadPublishGateFacts } from "./facts";
import { resolveArticlePublishTimeForWrite } from "./resolve-publish-time";

export type Dependencies = {
  db: PrismaClient;
  identities: AdminIdentityStore;
  sessions: SessionStore;
  now?: Date;
  env?: NodeJS.ProcessEnv;
};

export class PublishLifecycleError extends Error {
  readonly code:
    | "article_not_found"
    | "novel_not_found"
    | "novel_not_currently_published"
    | "novel_already_takedown"
    | "novel_not_currently_takedown"
    | "batch_too_large";
  readonly status = 409 as const;

  constructor(code: PublishLifecycleError["code"], message: string) {
    super(message);
    this.name = "PublishLifecycleError";
    this.code = code;
  }
}

function trimmedReason(value: string | undefined, required: boolean): string | null {
  const normalized = value?.trim() ?? "";
  if (required && !normalized) throw new Error("A reason is required");
  if (normalized.length > 1000) throw new Error("Reason is too long");
  return normalized || null;
}

// ---------------------------------------------------------------------------
// applyPublishTransition — the sole gated entry point into `published`.
// ---------------------------------------------------------------------------

/**
 * Who is asking. Admin actions carry a real, session-bound identity;
 * `"system"` is for a future scheduled-publish sweep
 * (`publishDueScheduledArticles` below) — there is no human session at the
 * moment a `publishAt` deadline is reached, so it cannot carry an
 * `AdminServiceAuthorization`. Both funnel through the exact same gate.
 */
export type PublishTransitionActor =
  | { readonly type: "admin"; readonly adminId: string }
  | { readonly type: "system"; readonly source: string };

export type ApplyPublishTransitionInput = {
  readonly articleId: string;
  readonly requestId: string;
  readonly actor: PublishTransitionActor;
  readonly now?: Date;
};

export type ApplyPublishTransitionResult =
  | {
      readonly outcome: "published";
      readonly articleId: string;
      readonly novelId: string;
      readonly locale: string;
      /** True only the first time this Article ever reached `published`. */
      readonly firstPublish: boolean;
    }
  | { readonly outcome: "rejected"; readonly gate: PublishGateEvaluation }
  | { readonly outcome: "not_found" }
  | {
      /**
       * The Article's (or its Novel's) status changed between this
       * transaction's read and its conditional write — e.g. a concurrent
       * `takedownNovel` committed in between. The write was refused, not
       * silently applied over the interference (see this module's header,
       * "TOCTOU"). Safe to retry: a fresh call reloads facts and
       * re-evaluates the gate against whatever is current now.
       */
      readonly outcome: "conflict";
    };

function auditActorType(actor: PublishTransitionActor): "admin" | "system" {
  return actor.type;
}

function auditActorId(actor: PublishTransitionActor): string {
  return actor.type === "admin" ? actor.adminId : actor.source;
}

function dispatchSource(actor: PublishTransitionActor): string {
  return actor.type === "admin" ? "admin.article.publish" : `system.${actor.source}`;
}

const PUBLISH_AUDIT_ACTION = "article.publish";

/** Internal shape returned from inside the transaction — `wrote` distinguishes a real write from an idempotent no-op replay before mapping to the public `ApplyPublishTransitionResult`. */
type TxPublishOutcome =
  | { readonly outcome: "not_found" }
  | { readonly outcome: "rejected"; readonly gate: PublishGateEvaluation }
  | {
      readonly outcome: "published";
      readonly articleId: string;
      readonly novelId: string;
      readonly locale: string;
      readonly firstPublish: boolean;
      readonly wrote: boolean;
    };

/**
 * Thrown (never returned) when a conditional `updateMany` reports
 * `count !== 1` — i.e. a concurrent transaction changed the row between this
 * transaction's read and its write. Throwing rather than returning a
 * `"conflict"` value is load-bearing: Prisma's interactive `$transaction`
 * only rolls back on a thrown error. If the Article-side `updateMany` had
 * already succeeded (`count === 1`) before a later Novel-side conflict is
 * detected, *returning* a value would let that Article write COMMIT anyway
 * — publishing the Article while reporting "conflict" to the caller. This
 * class exists purely to force the rollback; it never crosses this
 * function's boundary (caught below and mapped to `{ outcome: "conflict" }`).
 */
class PublishConflictSignal extends Error {}

export async function applyPublishTransition(
  db: PrismaClient,
  input: ApplyPublishTransitionInput,
): Promise<ApplyPublishTransitionResult> {
  const now = input.now ?? new Date();
  const actorType = auditActorType(input.actor);
  const actorId = auditActorId(input.actor);

  let txResult: TxPublishOutcome;
  try {
    txResult = await db.$transaction<TxPublishOutcome>(async (tx) => {
      // Facts + gate are read and evaluated against `tx`, not the top-level
      // `db` — see this module's header, "TOCTOU". Loading them earlier via
      // `db` left a window between the read and the write where a
      // concurrent rights transition could commit and then be silently
      // overwritten.
      const loaded = await loadPublishGateFacts(tx, input.articleId);
      if (!loaded) return { outcome: "not_found" };
      const { facts, article } = loaded;

      const gate = evaluatePublishGate(facts);
      if (!gate.publishable) {
        return { outcome: "rejected", gate };
      }

      // Idempotency check: sequential-retry-safe only, NOT concurrency-safe.
      // `OperationAudit` carries no unique constraint on (actorType, action,
      // entityType, entityId, requestId) — only a plain index
      // (`prisma/schema.prisma` — see `operation_audit_request_idx`) — so
      // this is check-then-insert. Two genuinely concurrent calls with the
      // same requestId can both pass this check before either commits its
      // audit row, producing two audit rows and two
      // `dispatchFirstPublicPublication` calls. A retried call *after* the
      // original committed (the ordinary "network timeout, client retries"
      // case) is safe. A partial unique index on `operation_audit` is
      // registered as a schema follow-up
      // (`docs/governance/database-governance.md` §13) rather than added
      // here — this round's schema is frozen.
      const existingAudit = await tx.operationAudit.findFirst({
        where: {
          actorType,
          action: PUBLISH_AUDIT_ACTION,
          entityType: "Article",
          entityId: article.id,
          requestId: input.requestId,
        },
      });
      if (existingAudit) {
        return {
          outcome: "published",
          articleId: article.id,
          novelId: article.novelId,
          locale: article.locale,
          firstPublish: false,
          wrote: false,
        };
      }

      const firstPublish = article.publishedAt === null;
      const publishedAt = resolveArticlePublishTimeForWrite({
        status: "published",
        existingPublishTime: article.publishedAt,
        now,
      })!; // non-null: status is "published" and resolveArticlePublishTimeForWrite
      // always returns a Date in that branch when no explicit time is given.

      // Conditional write: the WHERE precondition pins the row to the exact
      // status this same transaction just observed. If a concurrent
      // transaction committed a different status in between, `count` is 0
      // and this throws `PublishConflictSignal` rather than returning — see
      // that class's doc comment for why a thrown signal (not a returned
      // value) is required to actually roll back.
      const articleWrite = await tx.article.updateMany({
        where: { id: article.id, status: facts.article.status, deletedAt: null },
        data: { status: "published", publishedAt },
      });
      if (articleWrite.count !== 1) {
        throw new PublishConflictSignal();
      }

      // Idempotent: only writes when the Novel is not already published —
      // see this module's header for why Novel and Article publish
      // together. Same conditional-updateMany shape as the Article write
      // above, same throw-to-roll-back reasoning.
      if (facts.novel.status !== "published") {
        const novelWrite = await tx.novel.updateMany({
          where: { id: article.novelId, status: facts.novel.status, deletedAt: null },
          data: { status: "published" },
        });
        if (novelWrite.count !== 1) {
          throw new PublishConflictSignal();
        }
      }

      await tx.operationAudit.create({
        data: {
          actorType,
          actorId,
          action: PUBLISH_AUDIT_ACTION,
          entityType: "Article",
          entityId: article.id,
          requestId: input.requestId,
          beforeSnapshot: { articleStatus: facts.article.status, novelStatus: facts.novel.status },
          afterSnapshot: { articleStatus: "published", novelStatus: "published" },
        },
      });

      return {
        outcome: "published",
        articleId: article.id,
        novelId: article.novelId,
        locale: article.locale,
        firstPublish,
        wrote: true,
      };
    });
  } catch (error) {
    if (error instanceof PublishConflictSignal) {
      return { outcome: "conflict" };
    }
    throw error;
  }

  if (txResult.outcome === "published" && txResult.wrote && txResult.firstPublish) {
    await dispatchFirstPublicPublication(
      {
        articleId: txResult.articleId,
        novelId: txResult.novelId,
        locale: txResult.locale,
        source: dispatchSource(input.actor),
      },
      db,
    );
  }

  if (txResult.outcome === "published") {
    return {
      outcome: "published",
      articleId: txResult.articleId,
      novelId: txResult.novelId,
      locale: txResult.locale,
      firstPublish: txResult.firstPublish,
    };
  }
  return txResult;
}

// ---------------------------------------------------------------------------
// Batch publish — loops `applyPublishTransition` per item. Never `updateMany`
// straight to `published`: that is exactly CPS's `changeArticlesStatusByFilter`
// defect (`P2-07.md` §4 — "如果 P2-07 要做批量发布，必须逐条调用 evaluator（不能
// updateMany）"). The shared `requestId` plus a per-item `entityId` in the
// audit idempotency lookup means a *sequential* retry of the whole batch
// (e.g. after a timeout) redoes exactly the same items without double-
// writing. This is NOT a claim of concurrency safety: two literally-
// concurrent callers submitting the same batch requestId can still each
// pass the per-item idempotency check before either commits, for the same
// reason documented on `applyPublishTransition`'s `existingAudit` check
// above (no unique constraint backs it yet).
// ---------------------------------------------------------------------------

const MAX_BATCH_SIZE = 200;

export type PublishArticlesBatchResult = {
  readonly results: ReadonlyArray<{ readonly articleId: string; readonly result: ApplyPublishTransitionResult }>;
};

export async function publishArticlesBatch(
  db: PrismaClient,
  input: { articleIds: readonly string[]; requestId: string; actor: PublishTransitionActor; now?: Date },
): Promise<PublishArticlesBatchResult> {
  if (input.articleIds.length > MAX_BATCH_SIZE) {
    throw new PublishLifecycleError(
      "batch_too_large",
      `Batch publish is capped at ${MAX_BATCH_SIZE} articles per call, got ${input.articleIds.length}`,
    );
  }
  const results: Array<{ articleId: string; result: ApplyPublishTransitionResult }> = [];
  for (const articleId of input.articleIds) {
    const result = await applyPublishTransition(db, {
      articleId,
      requestId: input.requestId,
      actor: input.actor,
      now: input.now,
    });
    results.push({ articleId, result });
  }
  return { results };
}

// ---------------------------------------------------------------------------
// Scheduled-publish sweep — the "cron" side of Owner decision 6. No admin
// session exists at the moment a `publishAt` deadline is reached, so this
// calls `applyPublishTransition` with a `"system"` actor instead of an
// `AdminServiceAuthorization`. It goes through the exact same gate as the
// interactive path; nothing here bypasses it the way CPS's
// `instrumentation.ts:18-72` cron did. Wiring this onto an actual
// scheduler/GenericTask trigger is out of this PR's scope (that is
// scheduler/worker infrastructure, not gate logic) — this function is the
// gated primitive a future trigger calls, which is what closes the "cron
// bypass does not exist here from day one" requirement structurally rather
// than by policy.
// ---------------------------------------------------------------------------

export async function publishDueScheduledArticles(
  db: PrismaClient,
  input: { now?: Date; limit?: number } = {},
): Promise<PublishArticlesBatchResult> {
  const now = input.now ?? new Date();
  const limit = Math.min(input.limit ?? MAX_BATCH_SIZE, MAX_BATCH_SIZE);
  const due = await db.article.findMany({
    where: { status: "draft", deletedAt: null, publishAt: { lte: now } },
    select: { id: true },
    orderBy: [{ publishAt: "asc" }, { id: "asc" }],
    take: limit,
  });
  const results: Array<{ articleId: string; result: ApplyPublishTransitionResult }> = [];
  for (const { id } of due) {
    const result = await applyPublishTransition(db, {
      articleId: id,
      requestId: `scheduled-publish:${id}:${now.toISOString()}`,
      actor: { type: "system", source: "scheduled-publish" },
      now,
    });
    results.push({ articleId: id, result });
  }
  return { results };
}

// ---------------------------------------------------------------------------
// Novel-level rights transitions: withdraw (→ unpublished), takedown, and
// restore (→ draft, never straight back to published — see module header).
// Restrictions, not admissions: no gate call. Ported orchestration skeleton:
// CPS `offlineDrama`/`takedownDrama`/`restoreDrama`
// (`drama-publish-actions.ts:294-486`) — "look up affected articles → update
// status → downstream effects" — `P2-07.md` §C, COPY_THEN_ADAPT.
// ---------------------------------------------------------------------------

export type RightsTransitionKind = "withdraw" | "takedown" | "restore";

export type RightsTransitionResult = {
  readonly novelId: string;
  readonly novelStatus: NovelStatus;
  readonly affectedArticleIds: readonly string[];
};

const RIGHTS_TRANSITION_TARGET: Readonly<Record<RightsTransitionKind, NovelStatus>> = Object.freeze({
  withdraw: "unpublished",
  takedown: "takedown",
  restore: "draft",
});

const RIGHTS_TRANSITION_AUDIT_ACTION: Readonly<Record<RightsTransitionKind, string>> = Object.freeze({
  withdraw: "novel.withdraw",
  takedown: "novel.takedown",
  restore: "novel.restore",
});

const RIGHTS_TRANSITION_CAPABILITY = Object.freeze({
  withdraw: "content:publish",
  takedown: "content:takedown",
  restore: "content:takedown",
} as const);

function requireSourceStatus(kind: RightsTransitionKind, novelId: string, novelStatus: string): void {
  if (kind === "withdraw" && novelStatus !== "published") {
    throw new PublishLifecycleError(
      "novel_not_currently_published",
      `Novel ${novelId} is not currently published (status: ${novelStatus})`,
    );
  }
  if (kind === "takedown" && novelStatus === "takedown") {
    throw new PublishLifecycleError("novel_already_takedown", `Novel ${novelId} is already takedown`);
  }
  if (kind === "restore" && novelStatus !== "takedown") {
    throw new PublishLifecycleError(
      "novel_not_currently_takedown",
      `Novel ${novelId} is not currently takedown (status: ${novelStatus})`,
    );
  }
}

async function applyNovelRightsTransition(
  input: {
    authorization: AdminServiceAuthorization;
    entryId: `admin.${string}`;
    requestId: string;
    novelId: string;
    reason?: string;
    kind: RightsTransitionKind;
  },
  deps: Dependencies,
): Promise<RightsTransitionResult> {
  const capability = RIGHTS_TRANSITION_CAPABILITY[input.kind];
  const context = await requireFreshAdminServiceMutation(input.authorization, capability, {
    ...deps,
    entryId: input.entryId,
    requestId: input.requestId,
  });
  const why = trimmedReason(input.reason, true);
  const auditAction = RIGHTS_TRANSITION_AUDIT_ACTION[input.kind];
  const nextStatus = RIGHTS_TRANSITION_TARGET[input.kind];

  return deps.db.$transaction(async (tx) => {
    const existingAudit = await tx.operationAudit.findFirst({
      where: { actorType: "admin", action: auditAction, entityType: "Novel", entityId: input.novelId, requestId: input.requestId },
    });
    if (existingAudit) {
      const novel = await tx.novel.findUniqueOrThrow({ where: { id: input.novelId } });
      const articles = await tx.article.findMany({
        where: { novelId: input.novelId, deletedAt: null },
        select: { id: true },
      });
      return { novelId: input.novelId, novelStatus: novel.status as NovelStatus, affectedArticleIds: articles.map((a) => a.id) };
    }

    const novel = await tx.novel.findFirst({ where: { id: input.novelId, deletedAt: null } });
    if (!novel) throw new PublishLifecycleError("novel_not_found", `Novel ${input.novelId} does not exist`);
    requireSourceStatus(input.kind, input.novelId, novel.status);

    // Which Articles are in scope differs by kind: `takedown` cascades
    // unconditionally to every Article regardless of its current status
    // (rights removal "cascades down, never up" — `visibility.ts`'s
    // `isRightsBlocked` doc comment: a takedown Novel forces every Article to
    // read as rights-blocked "regardless of the Article's own status
    // column"). `withdraw`/`restore` only touch Articles actually in the
    // matching source state, leaving e.g. a never-published draft Article
    // alone during a Novel withdraw.
    const affected = await tx.article.findMany({
      where: {
        novelId: input.novelId,
        deletedAt: null,
        ...(input.kind === "withdraw" ? { status: "published" as const } : {}),
        ...(input.kind === "restore" ? { status: "takedown" as const } : {}),
      },
      select: { id: true },
    });
    const affectedArticleIds = affected.map((a) => a.id);

    await tx.novel.update({ where: { id: input.novelId }, data: { status: nextStatus } });
    if (affectedArticleIds.length > 0) {
      // Uniform, ungated bulk transition (every affected Article moves to the
      // same target status with no per-item admission decision) — not the
      // CPS `updateMany`-to-`published` defect this module exists to avoid.
      await tx.article.updateMany({
        where: { id: { in: affectedArticleIds } },
        data: { status: nextStatus },
      });
    }

    if (input.kind === "takedown") {
      const chapters = await tx.novelChapter.findMany({
        where: { novelId: input.novelId, deletedAt: null, status: { not: "withdrawn" } },
        select: { id: true },
      });
      if (chapters.length > 0) {
        const chapterIds = chapters.map((c) => c.id);
        // `novel_chapter.withdrawn` is the only chapter state whose workflow
        // deletes NovelChapterContent (`database-statuses.ts` doc comment) —
        // content deletion happens because of this rights transition, not as
        // an independent step a caller could forget.
        await tx.novelChapterContent.deleteMany({ where: { novelChapterId: { in: chapterIds } } });
        await tx.novelChapter.updateMany({ where: { id: { in: chapterIds } }, data: { status: "withdrawn" } });
      }
    }

    await tx.operationAudit.create({
      data: {
        actorType: "admin",
        actorId: context.identity.id,
        action: auditAction,
        entityType: "Novel",
        entityId: input.novelId,
        requestId: input.requestId,
        reason: why,
        beforeSnapshot: { novelStatus: novel.status },
        afterSnapshot: { novelStatus: nextStatus },
      },
    });

    return { novelId: input.novelId, novelStatus: nextStatus, affectedArticleIds };
  });
}

export async function withdrawNovel(
  input: { authorization: AdminServiceAuthorization; requestId: string; novelId: string; reason: string },
  deps: Dependencies,
): Promise<RightsTransitionResult> {
  return applyNovelRightsTransition(
    { ...input, entryId: "admin.novel.withdraw", kind: "withdraw" },
    deps,
  );
}

export async function takedownNovel(
  input: { authorization: AdminServiceAuthorization; requestId: string; novelId: string; reason: string },
  deps: Dependencies,
): Promise<RightsTransitionResult> {
  return applyNovelRightsTransition(
    { ...input, entryId: "admin.novel.takedown", kind: "takedown" },
    deps,
  );
}

export async function restoreNovel(
  input: { authorization: AdminServiceAuthorization; requestId: string; novelId: string; reason: string },
  deps: Dependencies,
): Promise<RightsTransitionResult> {
  return applyNovelRightsTransition(
    { ...input, entryId: "admin.novel.restore", kind: "restore" },
    deps,
  );
}

// ---------------------------------------------------------------------------
// Admin-facing wrapper for the gated publish path. Same shape as
// `src/server/credentials/service.ts`'s exported functions
// (`{ authorization, entryId, requestId, ... }` + `Dependencies`) — the
// template a future Server Action wires against
// (`src/app/(admin)/channel-accounts/_actions.ts`).
// ---------------------------------------------------------------------------

export async function publishArticleAsAdmin(
  input: { authorization: AdminServiceAuthorization; requestId: string; articleId: string },
  deps: Dependencies,
): Promise<ApplyPublishTransitionResult> {
  const context = await requireFreshAdminServiceMutation(input.authorization, "content:publish", {
    ...deps,
    entryId: "admin.article.publish",
    requestId: input.requestId,
  });
  return applyPublishTransition(deps.db, {
    articleId: input.articleId,
    requestId: input.requestId,
    actor: { type: "admin", adminId: context.identity.id },
  });
}

export async function publishArticlesBatchAsAdmin(
  input: { authorization: AdminServiceAuthorization; requestId: string; articleIds: readonly string[] },
  deps: Dependencies,
): Promise<PublishArticlesBatchResult> {
  const context = await requireFreshAdminServiceMutation(input.authorization, "content:publish", {
    ...deps,
    entryId: "admin.article.publish_batch",
    requestId: input.requestId,
  });
  return publishArticlesBatch(deps.db, {
    articleIds: input.articleIds,
    requestId: input.requestId,
    actor: { type: "admin", adminId: context.identity.id },
  });
}
