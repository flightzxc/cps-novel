import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  buildMoboreaderPreviewRequestsFromCatalogRow,
  createMoboreaderReadAdapter,
  moboreaderUpstreamRateGate,
  resolveMoboreaderUpstreamRateLimitConfig,
  MoboreaderAdapterError,
  MoboreaderRateLimitedError,
  type ListBooksResponse,
  type MoboreaderBook,
  type MoboreaderReadAdapter,
  type UpstreamRateLimitPolicyOptions,
} from "../../src/lib/adapters";
import {
  isNovelCatalogSyncEnabled,
  isNovelCatalogSyncWriteAllowed,
} from "../../src/lib/flags";
import {
  clampTotalChapterCount,
  catalogFinalizeGeneration,
  catalogPreviewRequestToken,
  failMoboreaderCatalogFinalize,
  MOBOREADER_CATALOG_MAX_ATTEMPTS,
  MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
  MOBOREADER_CATALOG_LIMITS,
  MOBOREADER_CATALOG_TARGET_TYPES,
  MOBOREADER_PREVIEW_ENV,
  normalizePaidFromChapter,
  paidFromChapterForUpdate,
  resolveMoboreaderPreviewRuntimeConfig,
  stageMoboreaderPreviewRefreshTask,
  totalChapterCountForUpdate,
  MOBOREADER_TASK_TYPES,
} from "../../src/lib/tasks/moboreader";
import { materializeChangduPreview } from "../../src/lib/preview";
import { rawLanguageScopeFromPayload } from "../../src/lib/tagging/raw-language-scope";
import { createHandlerRegistry, withTaskLeaseTransaction, type ProtectedWriteResult, type TaskHandler, type TaskLease } from "../../src/lib/tasks";
import {
  buildPromoLinkIdempotencyKey,
  UPSTREAM_EXISTING_PROMO_OFFER_TYPE,
} from "../../src/lib/tasks/promo-link-claim";
import {
  evaluateLanguageMappingSuspensions,
  resolveChannelLanguage,
  MOBOREADER_SOURCE_APP_CODE,
  type ChannelLanguageResolution,
} from "../../src/lib/locale/channel-language";
import { createPublicRedirectCode } from "../../src/lib/redirect";
import { decryptCredentialSecretForWorker } from "../credentials/crypto";
import { holdChannelAccountForPreview, isAccountLevelPreviewFailure } from "./preview-account-hold";
import { bindPromoLinkToArticles } from "./promo-link-binding";
import { logUpstreamCallObservation } from "../observability/upstream-call-log";

export interface MoboreaderCatalogPayload {
  pageIndex: number;
  pageSize: number;
  name: string;
  orderType: number;
  projectType: number;
  safetyMaxPages: number;
  requestedPageEnd: number;
  scheduledPageEnd: number;
  expiresAt: string;
  source: "manual";
  actorId: string;
  requestId: string;
}

export interface CatalogRecoveryIdentity {
  externalBookId: string;
  sourceLanguageCode: string;
}

export interface MoboreaderCatalogRecoveryPayload extends MoboreaderCatalogPayload {
  kind: "catalog_recovery_page";
  missingIdentities: CatalogRecoveryIdentity[];
  gapFingerprint: string;
}

function normalizedRecoveryIdentities(
  identities: readonly CatalogRecoveryIdentity[],
): CatalogRecoveryIdentity[] {
  const unique = new Map<string, CatalogRecoveryIdentity>();
  for (const identity of identities) {
    if (!identity.externalBookId || !identity.sourceLanguageCode) throw new Error("catalog_recovery_identity_invalid");
    const key = JSON.stringify([identity.externalBookId, identity.sourceLanguageCode]);
    unique.set(key, { externalBookId: identity.externalBookId, sourceLanguageCode: identity.sourceLanguageCode });
  }
  return Array.from(unique.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([, identity]) => identity);
}

export function catalogRecoveryFingerprint(identities: readonly CatalogRecoveryIdentity[]): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizedRecoveryIdentities(identities)), "utf8")
    .digest("hex");
}

export type MoboreaderCatalogStopReason =
  | "expected_total_reached"
  | "expected_pages_reached"
  | "empty_page"
  | "short_page"
  | "safety_limit"
  | "upstream_error";

export function determineMoboreaderCatalogStopReason(input: {
  returnedCount: number;
  pageSize: number;
  fetchedRaw: number;
  batchExpectedCount: number;
  pageIndex: number;
  requestedPageEnd: number;
  scheduledPageEnd: number;
}): Exclude<MoboreaderCatalogStopReason, "upstream_error"> | null {
  if (input.returnedCount === 0) return "empty_page";
  if (input.fetchedRaw >= input.batchExpectedCount) return "expected_total_reached";
  if (input.scheduledPageEnd < input.requestedPageEnd && input.pageIndex >= input.scheduledPageEnd) return "safety_limit";
  if (input.pageIndex >= input.requestedPageEnd) return "expected_pages_reached";
  if (input.returnedCount < input.pageSize) return "short_page";
  return null;
}

export function parseMoboreaderCatalogPayload(value: unknown): MoboreaderCatalogPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("catalog_payload_invalid");
  const item = value as Partial<MoboreaderCatalogPayload>;
  const integers = [
    item.pageIndex,
    item.pageSize,
    item.projectType,
    item.safetyMaxPages,
    item.requestedPageEnd,
    item.scheduledPageEnd,
    item.orderType,
  ];
  if (integers.some((number) => !Number.isSafeInteger(number))) throw new Error("catalog_payload_invalid");
  if (item.pageIndex! < 1 || item.pageSize! < 1 || item.pageSize! > MOBOREADER_CATALOG_LIMITS.maxPageSize) {
    throw new Error("catalog_payload_invalid");
  }
  if (item.safetyMaxPages! < 1 || item.requestedPageEnd! < item.pageIndex! || item.scheduledPageEnd! < item.pageIndex!) {
    throw new Error("catalog_payload_invalid");
  }
  if (item.source !== "manual" || typeof item.actorId !== "string" || !item.actorId || typeof item.requestId !== "string" || !item.requestId) {
    throw new Error("manual_source_required");
  }
  if (typeof item.expiresAt !== "string" || Number.isNaN(Date.parse(item.expiresAt))) throw new Error("task_expiry_invalid");
  if (typeof item.name !== "string") throw new Error("catalog_payload_invalid");
  return item as MoboreaderCatalogPayload;
}

export function parseMoboreaderCatalogRecoveryPayload(value: unknown): MoboreaderCatalogRecoveryPayload {
  const base = parseMoboreaderCatalogPayload(value);
  const item = value as Partial<MoboreaderCatalogRecoveryPayload>;
  if (item.kind !== MOBOREADER_CATALOG_TARGET_TYPES.recoveryPage || !Array.isArray(item.missingIdentities)) {
    throw new Error("catalog_recovery_payload_invalid");
  }
  if (typeof item.gapFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.gapFingerprint)) {
    throw new Error("catalog_recovery_fingerprint_invalid");
  }
  const missingIdentities = normalizedRecoveryIdentities(item.missingIdentities);
  if (missingIdentities.length < 1 || missingIdentities.length > base.pageSize) {
    throw new Error("catalog_recovery_identity_count_invalid");
  }
  if (catalogRecoveryFingerprint(missingIdentities) !== item.gapFingerprint) {
    throw new Error("catalog_recovery_fingerprint_mismatch");
  }
  return { ...base, kind: item.kind, missingIdentities, gapFingerprint: item.gapFingerprint };
}

interface BindingRow {
  project_type: number;
  credential_id: string;
  encrypted_secret: Uint8Array;
  key_version: number;
}

interface CatalogTaskScope {
  channelAccountId: string;
  channelAppId: string;
  projectType: number;
  pageStart: number;
  pageEnd: number;
  pageSize: number;
  terminalPage: number | null;
}

/**
 * Phase C: `CatalogScanTask`'s former physical task-level columns
 * (`projectType`/`pageStart`/`pageEnd`/`pageSize`) are no longer columns —
 * `GenericTask` has no such fields — they live in `GenericTask.params`
 * (written once, at creation, by `createMoboreaderCatalogScanTask` in
 * `src/lib/tasks/moboreader.ts`, the sole writer). This is the sole reader.
 */
export function parseCatalogScanTaskParams(value: unknown): {
  projectType: number;
  pageStart: number;
  pageEnd: number;
  pageSize: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("catalog_task_missing");
  const params = value as Record<string, unknown>;
  const { projectType, pageStart, pageEnd, pageSize } = params;
  if (
    !Number.isSafeInteger(projectType)
    || !Number.isSafeInteger(pageStart)
    || !Number.isSafeInteger(pageEnd)
    || !Number.isSafeInteger(pageSize)
  ) {
    throw new Error("catalog_task_missing");
  }
  return {
    projectType: projectType as number,
    pageStart: pageStart as number,
    pageEnd: pageEnd as number,
    pageSize: pageSize as number,
  };
}

async function loadAndValidateTaskScope(
  db: PrismaClient,
  taskId: string,
  payload: MoboreaderCatalogPayload,
): Promise<CatalogTaskScope> {
  const task = await db.genericTask.findUnique({
    where: { id: taskId },
    select: { channelAccountId: true, channelAppId: true, params: true, result: true },
  });
  if (!task || !task.channelAccountId || !task.channelAppId) throw new Error("catalog_task_missing");
  const { projectType, pageStart, pageEnd, pageSize } = parseCatalogScanTaskParams(task.params);
  const pageCount = pageEnd - pageStart + 1;
  if (
    pageCount < 1
    || pageSize !== payload.pageSize
    || projectType !== payload.projectType
    || pageEnd !== payload.requestedPageEnd
    || payload.scheduledPageEnd > pageEnd
    || payload.scheduledPageEnd - pageStart + 1 > payload.safetyMaxPages
    || payload.pageIndex < pageStart
    || payload.pageIndex > payload.scheduledPageEnd
  ) {
    throw new Error("catalog_task_bounds_mismatch");
  }
  return {
    channelAccountId: task.channelAccountId,
    channelAppId: task.channelAppId,
    projectType,
    pageStart,
    pageEnd,
    pageSize,
    terminalPage: Number.isSafeInteger(plainJson(task.result).terminalPage)
      ? plainJson(task.result).terminalPage as number
      : null,
  };
}

async function loadBinding(db: PrismaClient, payload: MoboreaderCatalogPayload, accountId: string, appId: string) {
  const rows = await db.$queryRaw<BindingRow[]>(Prisma.sql`
    SELECT ca.project_type, credential.id AS credential_id,
           credential.encrypted_secret, credential.key_version
    FROM channel_app ca
    JOIN channel c ON c.id = ca.channel_id AND c.status = 'active'
    JOIN channel_account account ON account.channel_id = c.id
      AND account.id = ${accountId}::uuid AND account.status = 'active' AND account.deleted_at IS NULL
    JOIN channel_account_credential credential ON credential.channel_account_id = account.id
      AND credential.status = 'active'
    JOIN channel_capability capability ON capability.channel_app_id = ca.id
      AND capability.capability_key = 'getlistpc' AND capability.status = 'enabled'
      AND capability.side_effecting = false
    WHERE ca.id = ${appId}::uuid AND ca.status = 'active'
      AND ca.project_type = ${payload.projectType}
    ORDER BY credential.created_at DESC
    LIMIT 2
  `);
  if (rows.length !== 1) throw new Error(rows.length === 0 ? "catalog_binding_unavailable" : "credential_ambiguous");
  return rows[0];
}

function decimal(value: number | null): Prisma.Decimal | null {
  return value === null ? null : new Prisma.Decimal(value);
}

const SOURCE_LABEL_KINDS = ["series_type", "recommend", "language", "agency"] as const;
type SourceLabelKind = (typeof SOURCE_LABEL_KINDS)[number];

export interface DroppedLabelGroup {
  kind: SourceLabelKind;
  length: number;
  sha256: string;
  count: number;
}

export interface DroppedLabelsSummary {
  count: number;
  groups: DroppedLabelGroup[];
}

interface SourceLabelWrite {
  kind: SourceLabelKind;
  value: string;
  displayValue?: string;
}

export interface SourceLabelWritePlan {
  labels: SourceLabelWrite[];
  droppedLabels: DroppedLabelsSummary;
}

function droppedLabelsJson(summary: DroppedLabelsSummary): Prisma.InputJsonObject {
  return summary as unknown as Prisma.InputJsonObject;
}

function postgresCharacterLength(value: string): number {
  return Array.from(value).length;
}

function droppedLabel(kind: SourceLabelKind, value: string): DroppedLabelGroup {
  return {
    kind,
    length: postgresCharacterLength(value),
    sha256: createHash("sha256").update(value, "utf8").digest("hex"),
    count: 1,
  };
}

function isSourceLabelKind(value: unknown): value is SourceLabelKind {
  return typeof value === "string" && SOURCE_LABEL_KINDS.includes(value as SourceLabelKind);
}

export function mergeDroppedLabels(summaries: readonly unknown[]): DroppedLabelsSummary {
  const groups = new Map<string, DroppedLabelGroup>();
  let count = 0;
  for (const summary of summaries) {
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) continue;
    const candidateGroups = (summary as { groups?: unknown }).groups;
    if (!Array.isArray(candidateGroups)) continue;
    for (const candidate of candidateGroups) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const group = candidate as Partial<DroppedLabelGroup>;
      if (
        !isSourceLabelKind(group.kind)
        || !Number.isSafeInteger(group.length) || group.length! < 0
        || typeof group.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(group.sha256)
        || !Number.isSafeInteger(group.count) || group.count! < 1
      ) continue;
      const key = `${group.kind}\n${group.length}\n${group.sha256}`;
      const groupCount = group.count!;
      const existing = groups.get(key);
      if (existing) existing.count += groupCount;
      else groups.set(key, {
        kind: group.kind,
        length: group.length!,
        sha256: group.sha256,
        count: groupCount,
      });
      count += groupCount;
    }
  }
  return {
    count,
    groups: Array.from(groups.values()).sort((left, right) => (
      left.kind.localeCompare(right.kind)
      || left.length - right.length
      || left.sha256.localeCompare(right.sha256)
    )),
  };
}

export function buildSourceLabelWritePlan(book: MoboreaderBook): SourceLabelWritePlan {
  const candidates: SourceLabelWrite[] = [
    ...book.seriesTypeList.map((value) => ({ kind: "series_type" as const, value })),
    ...book.recommendList.map((value) => ({ kind: "recommend" as const, value })),
    { kind: "language", value: book.language, displayValue: book.languageName ?? undefined },
    ...(book.agencyId
      ? [{ kind: "agency" as const, value: book.agencyId, displayValue: book.agencyName ?? undefined }]
      : []),
  ];
  const labels = new Map<string, SourceLabelWrite>();
  const dropped: DroppedLabelGroup[] = [];
  for (const candidate of candidates) {
    if (postgresCharacterLength(candidate.value) > 300) {
      dropped.push(droppedLabel(candidate.kind, candidate.value));
      continue;
    }
    const displayValue = candidate.displayValue?.trim() ? candidate.displayValue : undefined;
    const safeDisplayValue = displayValue && postgresCharacterLength(displayValue) > 300
      ? undefined
      : displayValue;
    if (displayValue && safeDisplayValue === undefined) {
      dropped.push(droppedLabel(candidate.kind, displayValue));
    }
    const key = `${candidate.kind}\n${candidate.value}`;
    const existing = labels.get(key);
    labels.set(key, {
      kind: candidate.kind,
      value: candidate.value,
      displayValue: safeDisplayValue ?? existing?.displayValue,
    });
  }
  return {
    labels: Array.from(labels.values()),
    droppedLabels: mergeDroppedLabels([{ groups: dropped }]),
  };
}

export interface TaskLabelSummary {
  droppedLabels: DroppedLabelsSummary;
  incompleteLabelSnapshots: number;
}

function sumIncompleteLabelSnapshots(results: Array<{ result: Prisma.JsonValue | null }>): number {
  return results.reduce((total, { result }) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) return total;
    const value = (result as Record<string, unknown>).incompleteLabelSnapshots;
    return Number.isSafeInteger(value) && (value as number) >= 0 ? total + (value as number) : total;
  }, 0);
}

async function loadTaskLabelSummary(
  tx: Prisma.TransactionClient | PrismaClient,
  taskId: string,
): Promise<TaskLabelSummary> {
  const results = await tx.genericTaskItem.findMany({
    where: { taskId, targetType: { in: [MOBOREADER_CATALOG_TARGET_TYPES.page, MOBOREADER_CATALOG_TARGET_TYPES.recoveryPage] } },
    select: { result: true },
  });
  const droppedLabels = mergeDroppedLabels(results.map(({ result }) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    return (result as Record<string, unknown>).droppedLabels;
  }));
  return { droppedLabels, incompleteLabelSnapshots: sumIncompleteLabelSnapshots(results) };
}

interface PersistLabelsResult {
  droppedLabels: DroppedLabelsSummary;
  incompleteLabelSnapshot: boolean;
}

async function persistLabels(
  tx: Prisma.TransactionClient,
  channelAppId: string,
  sourceItemId: string,
  book: MoboreaderBook,
  now: Date,
): Promise<PersistLabelsResult> {
  if (!book.labelSnapshotComplete) {
    return { droppedLabels: { count: 0, groups: [] }, incompleteLabelSnapshot: true };
  }
  const plan = buildSourceLabelWritePlan(book);
  for (const label of plan.labels) {
    const sourceLabel = await tx.sourceLabel.upsert({
      where: {
        channelAppId_labelKind_externalLabelValue: {
          channelAppId,
          labelKind: label.kind,
          externalLabelValue: label.value,
        },
      },
      create: {
        channelAppId,
        labelKind: label.kind,
        externalLabelValue: label.value,
        displayValue: label.displayValue,
      },
      update: label.displayValue === undefined ? {} : { displayValue: label.displayValue },
    });
    await tx.novelSourceItemLabel.upsert({
      where: {
        novelSourceItemId_sourceLabelId: { novelSourceItemId: sourceItemId, sourceLabelId: sourceLabel.id },
      },
      create: {
        novelSourceItemId: sourceItemId,
        sourceLabelId: sourceLabel.id,
        active: true,
        lastSeenAt: now,
      },
      // Upstream presence refreshes the observed fact only. `active=false` is
      // an explicit local operator/CLI decision and sync must not reactivate it.
      update: { lastSeenAt: now },
    });
  }
  return { droppedLabels: plan.droppedLabels, incompleteLabelSnapshot: false };
}

interface CatalogPromoSummary {
  fetched: number;
  deferredUntilLinked: number;
  incomplete: number;
  articlesBound: number;
  articlesConflicted: number;
}

function catalogPromoSummaryJson(summary: CatalogPromoSummary): Prisma.InputJsonObject {
  return summary as unknown as Prisma.InputJsonObject;
}

async function persistExistingCatalogPromo(
  tx: Prisma.TransactionClient,
  input: {
    source: { id: string; novelId: string | null; status: string };
    book: MoboreaderBook;
    channelAppId: string;
    channelAccountId: string;
    now: Date;
  },
): Promise<"absent" | "incomplete" | "deferred" | { articlesBound: number; articlesConflicted: number }> {
  const { upstreamCode, webUrl } = input.book.existingPromo;
  if (!upstreamCode && !webUrl) return "absent";
  if (!upstreamCode || !webUrl) return "incomplete";
  // PromoLink's schema requires a Novel FK. Secrets must not be staged in
  // rawPayload while a source is still unlinked, so the safe outcome is to
  // defer until a post-link catalog refresh can write the real destination.
  if (!input.source.novelId || input.source.status !== "linked") return "deferred";

  const idempotencyKey = buildPromoLinkIdempotencyKey({
    channelAppId: input.channelAppId,
    novelSourceItemId: input.source.id,
    channelAccountId: input.channelAccountId,
    offerType: UPSTREAM_EXISTING_PROMO_OFFER_TYPE,
  });
  const promoLink = await tx.promoLink.upsert({
    where: { idempotencyKey },
    create: {
      novelId: input.source.novelId,
      novelSourceItemId: input.source.id,
      channelAppId: input.channelAppId,
      channelAccountId: input.channelAccountId,
      offerType: UPSTREAM_EXISTING_PROMO_OFFER_TYPE,
      origin: "upstream_existing",
      upstreamCode,
      publicRedirectCode: createPublicRedirectCode(),
      webUrl,
      idempotencyKey,
      status: "fetched",
      fetchedAt: input.now,
    },
    // Preserve origin/appUrl on an existing row: a previously claimed row
    // remains claimed, and C2 did not prove `onlineUrl` is an app URL.
    update: {
      upstreamCode,
      webUrl,
      status: "fetched",
      errorKind: null,
      errorMessage: null,
      fetchedAt: input.now,
    },
    select: { id: true },
  });
  const binding = await bindPromoLinkToArticles(tx, input.source.novelId, promoLink.id);
  return {
    articlesBound: binding.boundArticleIds.length,
    articlesConflicted: binding.conflictedArticleIds.length,
  };
}

/**
 * L10N P1 write-site rule: `NovelSourceItem.sourceLocale` is either an
 * already-resolved locale string or `null` — **never** the literal string
 * `"unknown"` (the pre-P1 behavior this rule replaces). A code suspended by
 * this page's `evaluateLanguageMappingSuspensions` circuit-breaker is forced
 * to `null` regardless of what `resolveChannelLanguage` returned for it.
 * Pure/exported so this exact write-site expression has its own regression
 * test (`tests/backend/tasks/moboreader.test.ts`) independent of the full
 * `persistCatalogPage` transaction plumbing.
 */
export function pickBookSourceLocale(
  resolution: ChannelLanguageResolution,
  suspendedLanguageCodes: ReadonlySet<string>,
): string | null {
  return suspendedLanguageCodes.has(resolution.sourceLanguageCode) ? null : (resolution.locale ?? null);
}

async function persistCatalogPage(
  tx: Prisma.TransactionClient,
  input: {
    response: ListBooksResponse;
    baseResult: Prisma.InputJsonObject;
    payload: MoboreaderCatalogPayload;
    taskId: string;
    itemId: string;
    channelAppId: string;
    channelAccountId: string;
    env: NodeJS.ProcessEnv;
    now: Date;
    recoveryOnly?: boolean;
  },
): Promise<ProtectedWriteResult> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM generic_task WHERE id = ${input.taskId}::uuid FOR UPDATE`);
  // Phase C: the pre-Phase-C code wrote `returnedCount` here as a separate
  // early physical-column update, before this same item's own `result` JSON
  // (below) carried the identical value. That column no longer exists on
  // `GenericTaskItem` (Phase C folds it into `result.returnedCount`), and
  // the early write was provably redundant even before this migration: this
  // item's own status stays 'processing' until `guardedFinalize` runs after
  // this whole `protectedWrite` returns, so neither `beforeStop` nor
  // `afterStop` below (both scoped to sibling item aggregates) ever see it
  // in between. Folded into the one `result` write later in this function.
  const now = input.now;
  const sourceItemIds: string[] = [];
  const droppedLabels: DroppedLabelsSummary[] = [];
  const promoSummary: CatalogPromoSummary = {
    fetched: 0,
    deferredUntilLinked: 0,
    incomplete: 0,
    articlesBound: 0,
    articlesConflicted: 0,
  };
  let pageIncompleteLabelSnapshots = 0;
  // L10N P1: resolve every book's language up front (pass 1) so
  // `evaluateLanguageMappingSuspensions` (CPS `changdu-dry-run.ts:429-450`
  // shape, ported to `src/lib/locale/channel-language.ts`) can see the whole
  // page's code/name-conflict signal before any row is persisted — a code
  // whose resolutions disagree with their own paired `languageName` often
  // enough *in this page* gets its `sourceLocale` force-nulled for every
  // book on this page, not just the individual books that triggered the
  // conflict. Suspension is evaluated per `catalog_page` task item (one
  // upstream page fetch), the same granularity CPS's `resolveChannelLanguage`
  // call site uses.
  const pageLanguageResolutions: readonly ChannelLanguageResolution[] = input.response.items.map((book) =>
    resolveChannelLanguage({
      sourceAppCode: MOBOREADER_SOURCE_APP_CODE,
      sourceLanguageCode: book.language,
      sourceLanguageName: book.languageName,
    }),
  );
  const suspendedLanguageCodes = evaluateLanguageMappingSuspensions(
    pageLanguageResolutions.map((resolution) => ({
      sourceLanguageCode: resolution.sourceLanguageCode,
      warning: resolution.warning,
    })),
  );
  let pageUnknownLocaleCount = 0;
  for (const [bookIndex, book] of input.response.items.entries()) {
    const languageResolution = pageLanguageResolutions[bookIndex];
    const sourceLocale = pickBookSourceLocale(languageResolution, suspendedLanguageCodes);
    const rawLanguageScope = rawLanguageScopeFromPayload(book.rawEvidence);
    if (rawLanguageScope === null) throw new Error("MoboReader raw language scope is not reliably derivable");
    const createData = {
      channelAppId: input.channelAppId,
      externalBookId: book.externalBookId,
      sourceLanguageCode: book.language,
      sourceLanguageName: book.languageName,
      sourceLocale,
      rawLanguageScope,
      title: book.title,
      description: book.description ?? "",
      coverUrl: book.coverUrl,
      totalChapterCount: book.allEpis === null ? 0 : clampTotalChapterCount(book.allEpis),
      paidFromChapter: normalizePaidFromChapter(book.payEpisFrom),
      splitRatio: decimal(book.splitRatio),
      ttoSplitRatio: decimal(book.ttoSplitRatio),
      externalAgencyId: book.agencyId,
      sourceCreatedAtRaw: book.createTime,
      lastSeenAt: now,
      rawPayload: book.rawEvidence as Prisma.InputJsonObject,
    } satisfies Prisma.NovelSourceItemCreateManyInput;
    let source: { id: string; novelId: string | null; status: string };
    if (input.recoveryOnly) {
      const inserted = await tx.novelSourceItem.createMany({ data: [createData], skipDuplicates: true });
      if (inserted.count === 0) continue;
      source = await tx.novelSourceItem.findUniqueOrThrow({
        where: {
          channelAppId_externalBookId_sourceLanguageCode: {
            channelAppId: input.channelAppId,
            externalBookId: book.externalBookId,
            sourceLanguageCode: book.language,
          },
        },
        select: { id: true, novelId: true, status: true },
      });
    } else {
      source = await tx.novelSourceItem.upsert({
        where: {
          channelAppId_externalBookId_sourceLanguageCode: {
            channelAppId: input.channelAppId,
            externalBookId: book.externalBookId,
            sourceLanguageCode: book.language,
          },
        },
        create: createData,
        update: {
          sourceLanguageName: book.languageName ?? undefined,
          sourceLocale,
          rawLanguageScope,
          title: book.title,
          description: book.description ?? undefined,
          coverUrl: book.coverUrl ?? undefined,
          totalChapterCount: totalChapterCountForUpdate(book.allEpis),
        // An upstream 0 (or negative) must explicitly overwrite a previous
        // positive value with NULL ("free now"); see
        // `paidFromChapterForUpdate` for why this cannot be
        // `book.payEpisFrom ?? undefined` (that would pass 0 straight
        // through to the `paid_from_chapter > 0` DB CHECK — the crash this
        // fix removes).
          paidFromChapter: paidFromChapterForUpdate(book.payEpisFrom),
          splitRatio: book.splitRatio === null ? undefined : decimal(book.splitRatio),
          ttoSplitRatio: book.ttoSplitRatio === null ? undefined : decimal(book.ttoSplitRatio),
          externalAgencyId: book.agencyId ?? undefined,
          sourceCreatedAtRaw: book.createTime ?? undefined,
          lastSeenAt: now,
          deletedAt: null,
          rawPayload: book.rawEvidence as Prisma.InputJsonObject,
        },
        select: { id: true, novelId: true, status: true },
      });
    }
    if (sourceLocale === null) pageUnknownLocaleCount += 1;
    sourceItemIds.push(source.id);
    const promoResult = await persistExistingCatalogPromo(tx, {
      source,
      book,
      channelAppId: input.channelAppId,
      channelAccountId: input.channelAccountId,
      now,
    });
    if (promoResult === "incomplete") promoSummary.incomplete += 1;
    else if (promoResult === "deferred") promoSummary.deferredUntilLinked += 1;
    else if (promoResult !== "absent") {
      promoSummary.fetched += 1;
      promoSummary.articlesBound += promoResult.articlesBound;
      promoSummary.articlesConflicted += promoResult.articlesConflicted;
    }
    const labelResult = await persistLabels(tx, input.channelAppId, source.id, book, now);
    droppedLabels.push(labelResult.droppedLabels);
    if (labelResult.incompleteLabelSnapshot) pageIncompleteLabelSnapshots += 1;
  }
  const pageDroppedLabels = mergeDroppedLabels(droppedLabels);

  const [beforeStop] = await tx.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
    SELECT COALESCE(SUM((result->>'returnedCount')::int), 0)::bigint AS total
    FROM generic_task_item
    WHERE task_id = ${input.taskId}::uuid AND target_type = 'catalog_page' AND status = 'success'
  `);
  // The current page remains `processing` until guardedFinalize. Treat its
  // response as provisionally complete for this transaction's aggregate
  // calculations without moving the terminal status write out of the
  // fenced finalizer.
  const appliedCount = input.recoveryOnly ? sourceItemIds.length : input.response.items.length;
  const fetchedRaw = Number(beforeStop.total) + appliedCount;
  const task = await tx.genericTask.findUniqueOrThrow({
    where: { id: input.taskId },
    select: { params: true },
  });
  const { pageStart, pageEnd, pageSize } = parseCatalogScanTaskParams(task.params);
  const requestedCapacity = (pageEnd - pageStart + 1) * pageSize;
  const upstreamRemaining = Math.max(0, input.response.totalCount - (pageStart - 1) * pageSize);
  const batchExpectedCount = Math.min(requestedCapacity, upstreamRemaining);
  const stopReason = determineMoboreaderCatalogStopReason({
    returnedCount: appliedCount,
    pageSize: input.payload.pageSize,
    fetchedRaw,
    batchExpectedCount,
    pageIndex: input.payload.pageIndex,
    requestedPageEnd: input.payload.requestedPageEnd,
    scheduledPageEnd: input.payload.scheduledPageEnd,
  });

  const enrichedResult = {
    ...input.baseResult,
    returnedCount: appliedCount,
    stopReason,
    sourceItemIds,
    droppedLabels: droppedLabelsJson(pageDroppedLabels),
    incompleteLabelSnapshots: pageIncompleteLabelSnapshots,
    promoCapture: catalogPromoSummaryJson(promoSummary),
    // L10N P1 (施工提示词_Sonnet_L10N_P1_语言归一与存量重算_2026-09-10.md §1.D):
    // additive-only fields, same convention as `droppedLabels`/
    // `incompleteLabelSnapshots` above — this page's own count/codes, rolled
    // up into the task-level `result` at `terminal` below.
    unknownLocaleCount: pageUnknownLocaleCount,
    suspendedLanguageCodes: Array.from(suspendedLanguageCodes),
  } satisfies Prisma.InputJsonObject;

  // This provisional write makes the current page visible to the task-level
  // aggregation below. persistCatalogPage returns the exact same value as a
  // ProtectedWriteResult so guardedFinalize remains the sole terminal write
  // and cannot replace it with the handler's pre-persistence result.
  await tx.genericTaskItem.update({
    where: { id: input.itemId },
    data: { result: enrichedResult },
  });
  if (stopReason) {
    // `target_id` is a page index encoded as text (`GenericTaskItem.targetId`
    // is `VARCHAR`) — comparing it numerically against `input.payload.pageIndex`
    // needs an explicit cast Prisma's typed `updateMany` filter cannot express
    // (page indices exceed one digit, so a plain string `gt` would sort
    // lexically and misorder "10" before "9"). Raw SQL, same predicate shape
    // the pre-Phase-C `pageIndex: { gt: ... }` filter expressed.
    await tx.$executeRaw(Prisma.sql`
      UPDATE generic_task_item SET
        status = 'success',
        result = jsonb_build_object('stoppedBeforeFetch', true, 'stopReason', ${stopReason}, 'returnedCount', 0),
        finished_at = ${now}, updated_at = transaction_timestamp()
      WHERE task_id = ${input.taskId}::uuid AND target_type = 'catalog_page' AND status = 'pending'
        AND (target_id)::int > ${input.payload.pageIndex}
    `);
  }

  const [afterStop] = await tx.$queryRaw<Array<{ actual: bigint; failed: bigint }>>(Prisma.sql`
    SELECT COALESCE(SUM((result->>'returnedCount')::int), 0)::bigint AS actual,
           COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed
    FROM generic_task_item WHERE task_id = ${input.taskId}::uuid AND target_type = 'catalog_page'
  `);
  const batchActualCount = Number(afterStop.actual);
  let finalizeGeneration = 1;
  if (stopReason) {
    const finalizeItem = await tx.genericTaskItem.upsert({
      where: {
        taskId_targetType_targetId: {
          taskId: input.taskId,
          targetType: MOBOREADER_CATALOG_TARGET_TYPES.finalize,
          targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
        },
      },
      create: {
        taskId: input.taskId,
        targetType: MOBOREADER_CATALOG_TARGET_TYPES.finalize,
        targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
        payload: {
          kind: MOBOREADER_CATALOG_TARGET_TYPES.finalize,
          actorId: input.payload.actorId,
          requestId: input.payload.requestId,
          generation: 1,
        },
      },
      update: {},
      select: { payload: true },
    });
    finalizeGeneration = catalogFinalizeGeneration(plainJson(finalizeItem.payload).generation);
  }
  await tx.genericTask.update({
    where: { id: input.taskId },
    data: {
      result: {
        // Phase C: `catalogObservedTotal`/`batchExpectedCount`/
        // `batchActualCount` were physical `CatalogScanTask` columns
        // mutated on every page; folded into this same `result` write
        // (which already fully replaces the field on every call, so there
        // is no partial-merge hazard from moving them here).
        catalogObservedTotal: input.response.totalCount,
        batchExpectedCount,
        batchActualCount,
        checkpoint: {
          lastCompletedPage: input.payload.pageIndex,
          returnedCount: appliedCount,
          observedTotal: input.response.totalCount,
          completedAt: now.toISOString(),
        },
        stopReason,
        terminalPage: stopReason ? input.payload.pageIndex : null,
        finalization: stopReason ? {
          status: "pending", targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID, generation: finalizeGeneration,
        } : null,
        terminalState: "processing",
        completeness: {
          expected: batchExpectedCount,
          actual: batchActualCount,
          fetchedUniqueSourceItems: sourceItemIds.length,
          duplicateObservations: Math.max(0, batchActualCount - sourceItemIds.length),
        },
        // L10N P1: additive-only task-level fields, see `enrichedResult` above.
        unknownLocaleCount: pageUnknownLocaleCount,
        suspendedLanguageCodes: Array.from(suspendedLanguageCodes),
        previewEnqueue: null,
        droppedLabels: droppedLabelsJson(pageDroppedLabels),
        incompleteLabelSnapshots: pageIncompleteLabelSnapshots,
      },
    },
  });
  await tx.operationAudit.create({
    data: {
      actorType: "admin",
      actorId: input.payload.actorId,
      action: `moboreader.catalog_page.applied.${input.payload.pageIndex}`,
      entityType: "GenericTaskItem",
      entityId: input.itemId,
      requestId: input.payload.requestId,
      taskType: MOBOREADER_TASK_TYPES.catalogScan,
      taskId: input.taskId,
      afterSnapshot: {
        pageIndex: input.payload.pageIndex,
        returnedCount: appliedCount,
        observedTotal: input.response.totalCount,
        stopReason,
        droppedLabels: droppedLabelsJson(pageDroppedLabels),
        incompleteLabelSnapshots: pageIncompleteLabelSnapshots,
        promoCapture: catalogPromoSummaryJson(promoSummary),
      },
    },
  });
  return { status: "success", result: enrichedResult };
}

async function persistCatalogUpstreamFailure(
  tx: Prisma.TransactionClient,
  input: {
    taskId: string;
    itemId: string;
    payload: MoboreaderCatalogPayload;
    channelAppId: string;
    channelAccountId: string;
    env: NodeJS.ProcessEnv;
    now: Date;
  },
) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM generic_task WHERE id = ${input.taskId}::uuid FOR UPDATE`);
  const now = input.now;
  // Same numeric-`target_id` cast reasoning as the stop-cascade in
  // `persistCatalogPage` above — raw SQL, not Prisma's typed `updateMany`.
  await tx.$executeRaw(Prisma.sql`
    UPDATE generic_task_item SET
      status = 'failed',
      error = ${JSON.stringify({ code: "upstream_error", message: "Catalog scan stopped after an upstream error" })}::jsonb,
      result = ${JSON.stringify({ stoppedBeforeFetch: true, stopReason: "upstream_error" })}::jsonb,
      finished_at = ${now}, updated_at = transaction_timestamp()
    WHERE task_id = ${input.taskId}::uuid AND target_type = 'catalog_page' AND status = 'pending'
      AND (target_id)::int > ${input.payload.pageIndex}
  `);
  const [totals] = await tx.$queryRaw<Array<{
    actual: bigint;
    expected: number | null;
    observed_total: number | null;
    prior_result: Prisma.JsonValue | null;
  }>>(Prisma.sql`
    SELECT COALESCE(SUM((i.result->>'returnedCount')::int), 0)::bigint AS actual,
           (t.result->>'batchExpectedCount')::int AS expected,
           (t.result->>'catalogObservedTotal')::int AS observed_total,
           t.result AS prior_result
    FROM generic_task t
    LEFT JOIN generic_task_item i ON i.task_id = t.id AND i.target_type = 'catalog_page'
    WHERE t.id = ${input.taskId}::uuid
    GROUP BY t.id
  `);
  const actual = Number(totals.actual);
  const expected = totals.expected ?? actual;
  // Phase C: `catalogObservedTotal`/`batchExpectedCount` used to be separate
  // physical `CatalogScanTask` columns this failure path never touched, so a
  // failed page after an earlier successful one kept whatever those columns
  // already held. Now that both live inside the same `result` JSON blob this
  // function replaces wholesale, they must be explicitly carried forward
  // from the prior `result` (read above) instead of silently dropping to
  // `undefined`.
  const priorObservedTotal = totals.observed_total;
  const priorBatchExpectedCount = totals.expected;
  const priorTaskResult = totals.prior_result && typeof totals.prior_result === "object" && !Array.isArray(totals.prior_result)
    ? totals.prior_result
    : {};
  const finalizeItem = await tx.genericTaskItem.upsert({
    where: {
      taskId_targetType_targetId: {
        taskId: input.taskId,
        targetType: MOBOREADER_CATALOG_TARGET_TYPES.finalize,
        targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
      },
    },
    create: {
      taskId: input.taskId,
      targetType: MOBOREADER_CATALOG_TARGET_TYPES.finalize,
      targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
      payload: {
        kind: MOBOREADER_CATALOG_TARGET_TYPES.finalize,
        actorId: input.payload.actorId,
        requestId: input.payload.requestId,
        generation: 1,
      },
    },
    update: {},
    select: { payload: true },
  });
  const finalizeGeneration = catalogFinalizeGeneration(plainJson(finalizeItem.payload).generation);
  await tx.genericTask.update({
    where: { id: input.taskId },
    data: {
      result: {
        ...priorTaskResult,
        // Phase C: `catalogObservedTotal`/`batchExpectedCount`/
        // `batchActualCount` folded into `result` (no physical columns on
        // `GenericTask`) — see `persistCatalogPage` above. The first two are
        // carried forward from the prior `result` rather than dropped.
        catalogObservedTotal: priorObservedTotal,
        batchExpectedCount: priorBatchExpectedCount,
        batchActualCount: actual,
        stopReason: "upstream_error",
        terminalPage: input.payload.pageIndex,
        finalization: {
          status: "pending", targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID, generation: finalizeGeneration,
        },
        terminalState: "processing",
        completeness: {
          expected,
          actual,
          fetchedUniqueSourceItems: actual,
          duplicateObservations: 0,
        },
        previewEnqueue: null,
      },
    },
  });
}

interface CatalogFinalizePayload {
  kind: "catalog_finalize";
  actorId: string;
  requestId: string;
  generation?: number;
}

function parseCatalogFinalizePayload(value: unknown): CatalogFinalizePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("catalog_finalize_payload_invalid");
  const payload = value as Partial<CatalogFinalizePayload>;
  if (payload.kind !== MOBOREADER_CATALOG_TARGET_TYPES.finalize) throw new Error("catalog_finalize_kind_invalid");
  if (typeof payload.actorId !== "string" || !payload.actorId) throw new Error("catalog_finalize_actor_required");
  if (typeof payload.requestId !== "string" || !payload.requestId) throw new Error("catalog_finalize_request_required");
  return { ...payload, generation: catalogFinalizeGeneration(payload.generation) } as CatalogFinalizePayload;
}

function plainJson(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function runCatalogFinalize(
  db: PrismaClient,
  lease: TaskLease,
  env: NodeJS.ProcessEnv,
  now: Date,
): Promise<ProtectedWriteResult> {
  const payload = parseCatalogFinalizePayload(lease.payload);
  const task = await db.genericTask.findUniqueOrThrow({
    where: { id: lease.taskId },
    select: { channelAccountId: true, channelAppId: true, result: true },
  });
  if (!task.channelAccountId || !task.channelAppId) throw new Error("catalog_finalize_scope_missing");
  const priorResult = plainJson(task.result);
  const priorFinalization = plainJson(priorResult.finalization);
  const generation = catalogFinalizeGeneration(payload.generation);
  if (priorFinalization.status === "completed" && catalogFinalizeGeneration(priorFinalization.generation) === generation) {
    return { status: "success", result: { finalization: "already_completed" } };
  }
  await withTaskLeaseTransaction(db, lease, async (tx) => {
    const current = await tx.genericTask.findUniqueOrThrow({ where: { id: lease.taskId }, select: { result: true } });
    await tx.genericTask.update({
      where: { id: lease.taskId },
      data: {
        result: {
          ...plainJson(current.result),
          finalization: {
            status: "processing",
            targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
            generation,
            attempt: lease.attemptCount,
            startedAt: now.toISOString(),
          },
        },
      },
    });
  });

  const itemResults = await db.genericTaskItem.findMany({
    where: {
      taskId: lease.taskId,
      targetType: { in: [MOBOREADER_CATALOG_TARGET_TYPES.page, MOBOREADER_CATALOG_TARGET_TYPES.recoveryPage] },
      status: "success",
    },
    select: { result: true },
  });
  const touchedSourceItemIds = Array.from(new Set(itemResults.flatMap(({ result }) => {
    const ids = plainJson(result).sourceItemIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  })));
  const batchActualCount = itemResults.reduce((sum, { result }) => {
    const value = plainJson(result).returnedCount;
    return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
  const suspendedCodes = new Set<string>();
  const unknownLocaleCount = itemResults.reduce((sum, { result }) => {
    const object = plainJson(result);
    if (Array.isArray(object.suspendedLanguageCodes)) {
      for (const code of object.suspendedLanguageCodes) if (typeof code === "string") suspendedCodes.add(code);
    }
    return sum + (typeof object.unknownLocaleCount === "number" && Number.isFinite(object.unknownLocaleCount)
      ? object.unknownLocaleCount
      : 0);
  }, 0);
  const labelSummary = await loadTaskLabelSummary(db, lease.taskId);
  const failedPages = await db.genericTaskItem.count({
    where: {
      taskId: lease.taskId,
      targetType: { in: [MOBOREADER_CATALOG_TARGET_TYPES.page, MOBOREADER_CATALOG_TARGET_TYPES.recoveryPage] },
      status: "failed",
    },
  });

  let previewEnqueue: Prisma.InputJsonObject | null = null;
  if (touchedSourceItemIds.length > 0) {
    const preview = await stageMoboreaderPreviewRefreshTask(db, {
      trigger: "auto",
      catalogScanTaskId: lease.taskId,
      channelAccountId: task.channelAccountId,
      channelAppId: task.channelAppId,
      novelSourceItemIds: touchedSourceItemIds,
      requestToken: catalogPreviewRequestToken(lease.taskId, generation),
      actorId: payload.actorId,
      requestId: payload.requestId,
      mode: "apply",
    }, (write) => withTaskLeaseTransaction(db, lease, write), env, now);
    previewEnqueue = preview as unknown as Prisma.InputJsonObject;
  }

  const expected = typeof priorResult.batchExpectedCount === "number"
    ? priorResult.batchExpectedCount
    : (typeof priorResult.catalogObservedTotal === "number" ? priorResult.catalogObservedTotal : batchActualCount);
  const partialFailed = failedPages > 0
    || priorResult.stopReason === "safety_limit"
    || priorResult.stopReason === "upstream_error"
    || batchActualCount < expected;

  await withTaskLeaseTransaction(db, lease, async (tx) => {
    const current = await tx.genericTask.findUniqueOrThrow({ where: { id: lease.taskId }, select: { result: true } });
    await tx.genericTask.update({
      where: { id: lease.taskId },
      data: {
        result: {
          ...plainJson(current.result),
          batchActualCount,
          terminalState: partialFailed ? "partial_failed" : "completed",
          finalization: { status: "completed", generation, completedAt: now.toISOString() },
          completeness: {
            expected,
            actual: batchActualCount,
            fetchedUniqueSourceItems: touchedSourceItemIds.length,
            duplicateObservations: Math.max(0, batchActualCount - touchedSourceItemIds.length),
          },
          unknownLocaleCount,
          suspendedLanguageCodes: Array.from(suspendedCodes),
          previewEnqueue,
          droppedLabels: droppedLabelsJson(labelSummary.droppedLabels),
          incompleteLabelSnapshots: labelSummary.incompleteLabelSnapshots,
        },
      },
    });
    await tx.operationAudit.create({
      data: {
        actorType: "worker", actorId: payload.actorId,
        action: "moboreader.catalog_finalize.completed", entityType: "GenericTask",
        entityId: lease.taskId, requestId: payload.requestId,
        taskType: MOBOREADER_TASK_TYPES.catalogScan, taskId: lease.taskId,
        afterSnapshot: {
          batchActualCount, fetchedUniqueSourceItems: touchedSourceItemIds.length,
          failedPages, previewEnqueue,
        },
      },
    });
  });

  return {
    status: "success",
    result: { batchActualCount, fetchedUniqueSourceItems: touchedSourceItemIds.length, failedPages, previewEnqueue },
  };
}

export interface MoboreaderHandlerDependencies {
  adapter?: MoboreaderReadAdapter;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/**
 * Maps this repo's env-resolved upstream rate-limit config (RC-3) onto the
 * adapter's `upstreamRateLimitPolicy` shape. Only used at the two
 * production default-adapter construction sites below — a caller that
 * supplies its own `dependencies.adapter` (every existing test) never
 * touches this, and `resolveMoboreaderUpstreamRateLimitConfig` fails fast
 * on a malformed override the same way `resolveMoboreaderPreviewRuntimeConfig`
 * already does for Preview envs.
 */
function upstreamRateLimitPolicyFromEnv(env: NodeJS.ProcessEnv): UpstreamRateLimitPolicyOptions {
  const config = resolveMoboreaderUpstreamRateLimitConfig(env);
  return {
    maxAttempts: config.maxRateLimitRetries,
    backoffBaseMs: config.backoffBaseMs,
    backoffCapMs: config.backoffCapMs,
    retryAfterCapMs: config.retryAfterCapMs,
    totalBudgetMs: config.totalBudgetMs,
  };
}

interface MoboreaderPreviewPayload {
  trigger: "manual" | "auto";
  actorId: string;
  requestId: string;
}

function parseMoboreaderPreviewPayload(value: unknown): MoboreaderPreviewPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("preview_payload_invalid");
  const payload = value as Partial<MoboreaderPreviewPayload>;
  if (payload.trigger !== "manual" && payload.trigger !== "auto") throw new Error("preview_trigger_invalid");
  if (typeof payload.actorId !== "string" || !payload.actorId) throw new Error("preview_actor_required");
  if (typeof payload.requestId !== "string" || !payload.requestId) throw new Error("preview_request_id_required");
  return payload as MoboreaderPreviewPayload;
}

function configuredSourceApps(env: NodeJS.ProcessEnv): Set<string> {
  return new Set((env[MOBOREADER_PREVIEW_ENV.sourceAppCodes] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
}

async function loadMoboreaderPreviewScope(db: PrismaClient, taskId: string, itemId: string, env: NodeJS.ProcessEnv) {
  const item = await db.channelSyncTaskItem.findUnique({
    where: { id: itemId },
    select: {
      taskId: true,
      novelSourceItemId: true,
      task: {
        select: {
          taskType: true,
          channelAccountId: true,
          channelAppId: true,
        },
      },
      novelSourceItem: {
        select: {
          id: true,
          novelId: true,
          channelAppId: true,
          externalAgencyId: true,
          sourceLanguageCode: true,
          rawPayload: true,
          deletedAt: true,
        },
      },
    },
  });
  if (!item || item.taskId !== taskId || item.task.taskType !== MOBOREADER_TASK_TYPES.previewRefresh) {
    throw new Error("preview_task_scope_invalid");
  }
  const source = item.novelSourceItem;
  if (!source.novelId || source.deletedAt || source.channelAppId !== item.task.channelAppId) {
    throw new Error("preview_source_binding_missing");
  }
  const app = await db.channelApp.findFirst({
    where: {
      id: item.task.channelAppId,
      status: "active",
      channel: { status: "active" },
      sourceApp: { status: "active" },
    },
    select: {
      channelId: true,
      projectType: true,
      sourceApp: { select: { code: true } },
      capabilities: {
        where: {
          capabilityKey: { in: ["getbydataid", "getchapterinfo"] },
          status: "enabled",
          sideEffecting: false,
        },
        select: { capabilityKey: true },
      },
    },
  });
  if (!app || !configuredSourceApps(env).has(app.sourceApp.code)) throw new Error("preview_channel_binding_unavailable");
  const capabilities = new Set(app.capabilities.map(({ capabilityKey }) => capabilityKey));
  if (!capabilities.has("getbydataid") || !capabilities.has("getchapterinfo")) {
    throw new Error("preview_read_capability_unavailable");
  }
  const account = await db.channelAccount.findFirst({
    where: {
      id: item.task.channelAccountId,
      channelId: app.channelId,
      status: "active",
      deletedAt: null,
    },
    select: {
      id: true,
      credentials: {
        where: { status: "active", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { id: true, encryptedSecret: true, keyVersion: true },
        orderBy: { createdAt: "desc" },
        take: 2,
      },
    },
  });
  if (!account) throw new Error("preview_account_unavailable");
  if (account.credentials.length !== 1) {
    // Split out from the single `credential_ambiguous` this used to throw for
    // both cases: zero usable credentials and two are different facts, both
    // already registered in `ClaimCredentialNotReadyCode`
    // (`src/lib/credentials/claim-readiness.ts`), and both are equally
    // account-level — so the *hold behaviour* below is identical either way.
    // What changes is only that the recorded `reason_code` now says which one
    // actually happened, instead of telling an operator to go looking for a
    // second credential that is not there.
    throw new Error(account.credentials.length === 0 ? "credential_missing" : "credential_ambiguous");
  }
  const requests = buildMoboreaderPreviewRequestsFromCatalogRow(source.rawPayload);
  if (
    requests.material.projectType !== app.projectType
    || String(requests.material.agencyId) !== source.externalAgencyId
    || String(requests.material.language) !== source.sourceLanguageCode
  ) {
    throw new Error("preview_catalog_identity_mismatch");
  }
  const credential = account.credentials[0];
  return {
    novelId: source.novelId,
    novelSourceItemId: source.id,
    requests,
    token: decryptCredentialSecretForWorker(
      credential.encryptedSecret,
      account.id,
      credential.id,
      credential.keyVersion,
    ),
  };
}

export function createMoboreaderCatalogHandler(
  db: PrismaClient,
  dependencies: MoboreaderHandlerDependencies = {},
): TaskHandler {
  const env = dependencies.env ?? process.env;
  const adapter = dependencies.adapter ?? createMoboreaderReadAdapter({
    rateGate: moboreaderUpstreamRateGate,
    upstreamRateLimitPolicy: upstreamRateLimitPolicyFromEnv(env),
    onUpstreamObservation: logUpstreamCallObservation,
  });
  const now = dependencies.now ?? (() => new Date());
  return async ({ lease, mode, signal }) => {
    if (lease.targetType === MOBOREADER_CATALOG_TARGET_TYPES.finalize) {
      if (mode !== "apply") {
        return { status: "failed", error: { code: "catalog_finalize_mode_invalid", message: "Catalog finalization requires apply mode" } };
      }
      if (!isNovelCatalogSyncEnabled(env)) {
        return { status: "failed", error: { code: "feature_disabled", message: "Catalog sync feature is disabled" } };
      }
      if (!isNovelCatalogSyncWriteAllowed(env)) {
        return { status: "failed", error: { code: "write_disabled", message: "Catalog sync write gate is disabled" } };
      }
      try {
        return await runCatalogFinalize(db, lease, env, now());
      } catch {
        if (lease.attemptCount >= MOBOREADER_CATALOG_MAX_ATTEMPTS) {
          try {
            const payload = parseCatalogFinalizePayload(lease.payload);
            await withTaskLeaseTransaction(db, lease, (tx) => failMoboreaderCatalogFinalize(tx, {
              catalogTaskId: lease.taskId,
              generation: catalogFinalizeGeneration(payload.generation),
              actorId: payload.actorId,
              requestId: payload.requestId,
              reason: "retry_exhausted",
              now: now(),
            }));
          } catch {
            // The final item outcome still records the exhausted failure; a
            // preserved disabled/building shell remains non-claimable evidence.
          }
        }
        return {
          status: "retry",
          error: { code: "catalog_finalize_failed", message: "Catalog task finalization failed and will be retried" },
        };
      }
    }
    const recoveryPayload = lease.targetType === MOBOREADER_CATALOG_TARGET_TYPES.recoveryPage
      ? parseMoboreaderCatalogRecoveryPayload(lease.payload)
      : null;
    const payload = recoveryPayload ?? parseMoboreaderCatalogPayload(lease.payload);
    if (!isNovelCatalogSyncEnabled(env)) {
      return { status: "failed", error: { code: "feature_disabled", message: "Catalog sync feature is disabled" } };
    }
    if (mode === "apply" && !isNovelCatalogSyncWriteAllowed(env)) {
      return { status: "failed", error: { code: "write_disabled", message: "Catalog sync write gate is disabled" } };
    }
    if (now().valueOf() >= Date.parse(payload.expiresAt)) {
      return { status: "failed", error: { code: "task_expired", message: "Catalog scan task expired" } };
    }
    const scope = await loadAndValidateTaskScope(db, lease.taskId, payload);
    if (scope.terminalPage !== null && payload.pageIndex > scope.terminalPage) {
      return {
        status: "success",
        result: {
          stoppedBeforeFetch: true,
          stopReason: "expected_total_reached",
          returnedCount: 0,
          terminalPage: scope.terminalPage,
        },
      };
    }
    const binding = await loadBinding(db, payload, scope.channelAccountId, scope.channelAppId);
    const token = decryptCredentialSecretForWorker(
      binding.encrypted_secret,
      scope.channelAccountId,
      binding.credential_id,
      binding.key_version,
    );
    let response: ListBooksResponse;
    try {
      response = await adapter.listBooks({
        name: payload.name,
        orderType: payload.orderType,
        pageIndex: payload.pageIndex,
        pageSize: payload.pageSize,
        projectType: payload.projectType,
      }, token, signal);
    } catch (error) {
      // RC-3: a `MoboreaderRateLimitedError` gets a richer, page-aware error
      // message for operators, but the outcome shape (`status: "failed"`,
      // `result.stopReason: "upstream_error"`, same `protectedWrite`) is
      // byte-identical to the pre-existing generic-error path below — this
      // task's item is a page, so `generic_task_item` already lets an
      // operator resume from `payload.pageIndex` with a fresh scan task; no
      // new recovery mechanism.
      const rateLimited = error instanceof MoboreaderRateLimitedError;
      // C-10 (Phase E rework, 2026-09-07): before this, a `MoboreaderAdapterError`
      // (e.g. an upstream HTTP 401) fell into the generic
      // `{ code: "upstream_error", message: "MoboReader catalog read failed" }`
      // branch below, discarding the adapter's own code/HTTP status/retryable
      // flag — the exact information an operator needs to tell "bad
      // credential" (401) apart from "transient upstream failure" (5xx)
      // without reproducing the call in a container. `detail` carries only
      // the enumerated adapter code, HTTP status, retryable flag, and page
      // index — never the upstream response body, a token, or a URL — and is
      // itself narrowed again by `sanitizePersistedTaskError`'s allowlist
      // projection (`src/lib/tasks/errors.ts`) before persistence. The
      // outer contract `code` stays `"upstream_error"`, unchanged.
      const adapterError = error instanceof MoboreaderAdapterError ? error : null;
      return {
        status: "failed",
        result: { stopReason: "upstream_error", terminalState: "partial_failed" },
        error: rateLimited
          ? {
              code: "upstream_rate_limited",
              message: `MoboReader catalog read rate limited at page ${payload.pageIndex} `
                + `(HTTP ${error.status}, ${error.reason}, retried ${error.attempts} time(s), `
                + `elapsed ${error.elapsedMs}ms). Resume a new scan from page ${payload.pageIndex}.`,
            }
          : adapterError
            ? {
                code: "upstream_error",
                message: `MoboReader catalog read failed: ${adapterError.code}`
                  + `${adapterError.status != null ? ` (HTTP ${adapterError.status})` : ""}`
                  + ` at page ${payload.pageIndex}`,
                detail: {
                  adapterCode: adapterError.code,
                  httpStatus: adapterError.status ?? null,
                  retryable: adapterError.retryable,
                  pageIndex: payload.pageIndex,
                },
              }
            : { code: "upstream_error", message: "MoboReader catalog read failed" },
        // Phase D D-1, 做法2: dry_run runs the real upstream call and the
        // real judgement above (`result.stopReason` etc. are unconditional),
        // but must never attach a `protectedWrite` — `persistCatalogUpstreamFailure`
        // upserts real task-item/task rows and can enqueue a real (mode:
        // "apply") preview-refresh task. See the twin comment on the success
        // path below.
        ...(mode === "dry_run" ? {} : {
          protectedWrite: async (tx) => persistCatalogUpstreamFailure(tx, {
            taskId: lease.taskId,
            itemId: lease.itemId,
            payload,
            channelAppId: scope.channelAppId,
            channelAccountId: scope.channelAccountId,
            env,
            now: now(),
          }),
        }),
      };
    }
    if (response.items.length > payload.pageSize) {
      return {
        status: "failed",
        result: { stopReason: "upstream_error", terminalState: "partial_failed" },
        error: { code: "upstream_page_limit_exceeded", message: "Upstream page exceeded the requested page size" },
        ...(mode === "dry_run" ? {} : {
          protectedWrite: async (tx) => persistCatalogUpstreamFailure(tx, {
            taskId: lease.taskId,
            itemId: lease.itemId,
            payload,
            channelAppId: scope.channelAppId,
            channelAccountId: scope.channelAccountId,
            env,
            now: now(),
          }),
        }),
      };
    }
    if (recoveryPayload) {
      const existing = await db.novelSourceItem.findMany({
        where: {
          channelAppId: scope.channelAppId,
          OR: recoveryPayload.missingIdentities.map((identity) => ({
            externalBookId: identity.externalBookId,
            sourceLanguageCode: identity.sourceLanguageCode,
          })),
        },
        select: { externalBookId: true, sourceLanguageCode: true },
      });
      const existingKeys = new Set(existing.map((identity) => JSON.stringify([
        identity.externalBookId,
        identity.sourceLanguageCode,
      ])));
      const stillMissing = recoveryPayload.missingIdentities.filter((identity) => !existingKeys.has(JSON.stringify([
        identity.externalBookId,
        identity.sourceLanguageCode,
      ])));
      if (catalogRecoveryFingerprint(stillMissing) !== recoveryPayload.gapFingerprint) {
        return {
          status: "failed",
          error: { code: "catalog_recovery_gap_drift", message: "Catalog recovery gap changed after approval" },
        };
      }
      const missingKeys = new Set(stillMissing.map((identity) => JSON.stringify([
        identity.externalBookId,
        identity.sourceLanguageCode,
      ])));
      const recoveryItems = response.items.filter((book) => missingKeys.has(JSON.stringify([
        book.externalBookId,
        book.language,
      ])));
      if (recoveryItems.length !== stillMissing.length) {
        return {
          status: "failed",
          error: { code: "catalog_recovery_upstream_drift", message: "Approved catalog recovery identities are no longer present upstream" },
        };
      }
      response = { ...response, items: recoveryItems };
    }
    const observedFetchedPosition = (payload.pageIndex - 1) * payload.pageSize + response.items.length;
    const stopReason = determineMoboreaderCatalogStopReason({
      returnedCount: response.items.length,
      pageSize: payload.pageSize,
      fetchedRaw: observedFetchedPosition,
      batchExpectedCount: response.totalCount,
      pageIndex: payload.pageIndex,
      requestedPageEnd: payload.requestedPageEnd,
      scheduledPageEnd: payload.scheduledPageEnd,
    });
    const result = {
      source: "manual",
      mode,
      pageIndex: payload.pageIndex,
      returnedCount: response.items.length,
      observedTotal: response.totalCount,
      plannedSourceIds: response.items.map((item) => `${item.externalBookId}:${item.language}`),
      checkpoint: { pageIndex: payload.pageIndex },
      stopReason,
      ...(stopReason === "safety_limit" ? { terminalState: "partial_failed" } : {}),
    } satisfies Prisma.InputJsonObject;
    // Phase D (施工工单_PhaseD_安全与运行态收口_2026-09-06.md D-1, 做法2): the
    // real upstream fetch and the real stop-reason judgement above both ran
    // unconditionally — `result` (already carrying `mode`) reflects exactly
    // what an apply run would have decided. Only the write is conditional:
    // dry_run must terminate the item without ever calling
    // `persistCatalogPage` (source-item upsert, label writes, PromoLink
    // upsert + article binding, and an auto preview-refresh enqueue). Status
    // stays "success" rather than "skipped" — `guardedFinalize`
    // (`src/lib/tasks/store.ts`) enforces the pre-existing Phase C parity
    // invariant that a catalog-page item is success/failed only, never
    // skipped; this is a page-shaped record either way, dry_run or not.
    if (mode === "dry_run") {
      return { status: "success", result };
    }
    return {
      status: "success",
      result,
      protectedWrite: async (tx) => persistCatalogPage(tx, {
        response,
        baseResult: result,
        payload,
        taskId: lease.taskId,
        itemId: lease.itemId,
        channelAppId: scope.channelAppId,
        channelAccountId: scope.channelAccountId,
        env,
        now: now(),
        recoveryOnly: recoveryPayload !== null,
      }),
    };
  };
}

export function createMoboreaderPreviewHandler(
  db: PrismaClient,
  dependencies: MoboreaderHandlerDependencies = {},
): TaskHandler {
  const env = dependencies.env ?? process.env;
  const runtime = resolveMoboreaderPreviewRuntimeConfig(env);
  const adapter = dependencies.adapter ?? createMoboreaderReadAdapter({
    timeoutMs: runtime.timeoutMs,
    rateGate: moboreaderUpstreamRateGate,
    upstreamRateLimitPolicy: upstreamRateLimitPolicyFromEnv(env),
    onUpstreamObservation: logUpstreamCallObservation,
  });
  return async ({ lease, mode, signal }) => {
    if (!isNovelCatalogSyncEnabled(env)) {
      return { status: "failed", error: { code: "feature_disabled", message: "Preview refresh feature is disabled" } };
    }
    if (mode === "apply" && !isNovelCatalogSyncWriteAllowed(env)) {
      return { status: "failed", error: { code: "write_disabled", message: "Preview refresh write gate is disabled" } };
    }
    const payload = parseMoboreaderPreviewPayload(lease.payload);
    // Account-level deterministic-failure brake (Owner 2026-09-18 决策 2) —
    // layer 3 of three, see `src/lib/tasks/account-hold.ts`'s module header.
    //
    // This try/catch exists *only* to classify. Before it, every throw out of
    // `loadMoboreaderPreviewScope` — a bad credential exactly as much as a bad
    // book — surfaced identically as the runtime's generic `handler_failed`,
    // which is why the 2026-09-14 burn could not even be distinguished from
    // ordinary per-book noise without reading 79,183 error messages. Only the
    // codes `isAccountLevelPreviewFailure` recognises (the credential
    // taxonomy, which is derived from `channelAccountId` alone) brake the
    // account; every other code is re-thrown completely unchanged, so
    // per-book and transient failures keep the exact handling they have today.
    let scope: Awaited<ReturnType<typeof loadMoboreaderPreviewScope>>;
    try {
      scope = await loadMoboreaderPreviewScope(db, lease.taskId, lease.itemId, env);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (!isAccountLevelPreviewFailure(code)) throw error;
      // Read the account off the task rather than off `scope` — the loader
      // threw before it could return one.
      const task = await db.channelSyncTask.findUnique({
        where: { id: lease.taskId },
        select: { channelAccountId: true },
      });
      if (!task) throw error;
      return {
        status: "failed",
        error: { code, message: "MoboReader preview credential is unusable for this channel account" },
        protectedWrite: async (tx) => {
          await holdChannelAccountForPreview(tx, {
            channelAccountId: task.channelAccountId,
            reasonCode: code,
            taskId: lease.taskId,
            itemId: lease.itemId,
          });
        },
      };
    }
    try {
      await adapter.fetchBookMaterial(scope.requests.material, scope.token, signal);
    } catch {
      return {
        status: "failed",
        error: { code: "upstream_material_read_failed", message: "MoboReader material read failed" },
      };
    }
    let preview;
    try {
      preview = await adapter.fetchPreviewChapters(scope.requests.chapters, scope.token, signal);
    } catch {
      return {
        status: "failed",
        error: { code: "upstream_preview_read_failed", message: "MoboReader Preview read failed" },
      };
    }
    if (preview.chapterList.length === 0) {
      return {
        status: "skipped",
        result: {
          reason: "upstream_empty_preview",
          materialTypeSource: scope.requests.materialTypeSource,
          upstreamCount: 0,
        },
      };
    }
    // Phase D (施工工单_PhaseD_安全与运行态收口_2026-09-06.md D-1, 做法2): both
    // upstream reads and the empty-preview judgement above already ran for
    // real. dry_run must stop here, without ever calling
    // `materializeChangduPreview` (writes NovelChapter/NovelChapterContent) —
    // same "skipped, no protectedWrite" shape as
    // `worker/handlers/promo-link-claim.ts`'s own dry_run branch. Unlike the
    // catalog-scan item above, this family (`channel_sync`) has no
    // "no skipped" restriction in `guardedFinalize`.
    if (mode === "dry_run") {
      return {
        status: "skipped",
        result: {
          decision: "would_materialize",
          materialTypeSource: scope.requests.materialTypeSource,
          upstreamCount: preview.chapterList.length,
        },
      };
    }
    return {
      status: "success",
      result: {
        materialTypeSource: scope.requests.materialTypeSource,
        upstreamCount: preview.chapterList.length,
      },
      protectedWrite: async (tx) => {
        await materializeChangduPreview(tx, {
          novelId: scope.novelId,
          novelSourceItemId: scope.novelSourceItemId,
          sourceFetchId: lease.itemId,
          actorId: payload.actorId,
          requestId: payload.requestId,
          taskId: lease.taskId,
          chapterList: preview.chapterList,
          trustedCompleteResponse: true,
        });
      },
    };
  };
}

export function createMoboreaderWorkerHandlers(
  db: PrismaClient,
  dependencies: MoboreaderHandlerDependencies = {},
) {
  return createHandlerRegistry({
    [MOBOREADER_TASK_TYPES.catalogScan]: {
      // Phase C: CatalogScan is now a GenericTask taskType, not its own
      // family — TASK_FAMILIES has shrunk to ["channel_sync", "generic"].
      family: "generic",
      maxAttempts: MOBOREADER_CATALOG_MAX_ATTEMPTS,
      handler: createMoboreaderCatalogHandler(db, dependencies),
    },
    [MOBOREADER_TASK_TYPES.previewRefresh]: {
      family: "channel_sync",
      maxAttempts: 1,
      handler: createMoboreaderPreviewHandler(db, dependencies),
    },
  });
}
