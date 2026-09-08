/**
 * C-30B (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4B.4/§3.1). Verbatim
 * port of CPS `src/components/articles/batch-drama-switch-recovery.ts`
 * (74 lines) — the "令牌先落存储再发请求" mechanism (施工工单's own words:
 * "浏览器侧令牌恢复...一条都不需要新造"). Only the field names change
 * (`selectedArticleIds` stay `string[]` UUIDs here instead of CPS's
 * `number[]`; `direction` splits into `sourceChannelCode`/`targetChannelCode`;
 * `locale`/`sourceTheater` become `locale`/`sourceApp`).
 *
 * Control flow is untouched: save the pending-apply record to
 * `sessionStorage` (or whatever `RecoveryStorage` the caller passes)
 * BEFORE the batch-submit request goes out; on a request failure, the
 * caller looks up the batch by `requestToken` instead of resubmitting;
 * once a request resolves (success OR a definitive failure), the caller
 * marks the pending record `superseded` rather than deleting it outright —
 * an operator who navigated away and back can still see "this token was
 * already used" instead of silently finding nothing.
 */
export const REBIND_BATCH_PENDING_PREFIX = "novel-rebind:batch:pending:";

export type RebindBatchPendingApply = {
  requestToken: string;
  previewId: string;
  sourceChannelCode: string;
  targetChannelCode: string;
  selectedArticleIds: string[];
  reason: string;
  acknowledgeRisks: boolean;
  locale?: string;
  sourceApp?: string;
  savedAt: number;
  recoveryState?: "active" | "superseded";
  supersededAt?: number;
};

type RecoveryStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;

function pendingKey(requestToken: string): string {
  return `${REBIND_BATCH_PENDING_PREFIX}${requestToken}`;
}

function listPending(storage: RecoveryStorage): RebindBatchPendingApply[] {
  const candidates: RebindBatchPendingApply[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(REBIND_BATCH_PENDING_PREFIX)) continue;
    try {
      const parsed = JSON.parse(storage.getItem(key) ?? "null") as RebindBatchPendingApply | null;
      if (parsed?.requestToken && Array.isArray(parsed.selectedArticleIds)) candidates.push(parsed);
    } catch {
      // Ignore malformed browser-local recovery entries.
    }
  }
  return candidates.sort((a, b) => b.savedAt - a.savedAt);
}

/** 🔴 Must be called BEFORE the batch-submit request goes out (施工工单 §4B.4). */
export function saveRebindBatchPending(storage: RecoveryStorage, pending: RebindBatchPendingApply): void {
  storage.setItem(pendingKey(pending.requestToken), JSON.stringify(pending));
}

export function removeRebindBatchPending(storage: RecoveryStorage, requestToken: string): void {
  storage.removeItem(pendingKey(requestToken));
}

export function loadLatestActiveRebindBatchPending(storage: RecoveryStorage): RebindBatchPendingApply | null {
  return listPending(storage).find((pending) => pending.recoveryState !== "superseded") ?? null;
}

export function loadSupersededRebindBatchPending(storage: RecoveryStorage): RebindBatchPendingApply[] {
  return listPending(storage).filter((pending) => pending.recoveryState === "superseded");
}

export function supersedeRebindBatchPending(
  storage: RecoveryStorage,
  pending: RebindBatchPendingApply,
  supersededAt = Date.now(),
): RebindBatchPendingApply {
  const superseded: RebindBatchPendingApply = { ...pending, recoveryState: "superseded", supersededAt };
  saveRebindBatchPending(storage, superseded);
  return superseded;
}

export function resolveRebindBatchRecoveryLookup(detail: { batchId: string } | null): { kind: "found"; batchId: string } | { kind: "not_created" } {
  return detail ? { kind: "found" as const, batchId: detail.batchId } : { kind: "not_created" as const };
}
