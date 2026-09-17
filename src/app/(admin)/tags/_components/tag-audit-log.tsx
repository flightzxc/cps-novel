import type { AdminTagAuditEntryView } from "@/contracts";
import { formatDateTime } from "@/features/admin-ui/content-view";

/**
 * P2-06.5 CPS-parity F1: the frozen `AdminTagAuditEntryView` projection
 * (`lastMutation` / `audit` / `lastManualMutation`) was already reaching the
 * browser everywhere it needed to, but nothing rendered it — see the U2
 * finding in `docs/p2/P2-06-5-ADMIN-CPS-PARITY-AUDIT.md`. This file is the
 * one shared renderer for that projection, consumed by the Canonical Tag
 * detail expansion, the Source Label Mapping table, and the Novel tags
 * panel, modelled on CPS `home-carousel/page.tsx`'s 操作日志 section (action
 * chip + timestamp + operator + readable field diff, `max-h-96` scroll).
 */

/**
 * The complete, frozen key surface `projectAdminTagAuditEntry`'s two-layer
 * whitelist (`AUDIT_KEYS` in `@/contracts/tagging-admin.ts`) ever lets
 * through `before` / `after`. Duplicated here rather than imported — that
 * constant is module-private to that file — purely so this component can
 * walk a diff in one fixed, deterministic order instead of relying on
 * `Object.keys` insertion order, which is not guaranteed to line up between
 * `before` and `after` when a mutation only ever populates one side. Same
 * reuse discipline `tags/_components/tag-badges.tsx:15` documents for
 * copying a small owned piece across a module-private boundary.
 *
 * If `AUDIT_KEYS` ever grows a twelfth key, this list needs the same edit.
 */
const AUDIT_DIFF_KEYS = [
  "status",
  "translations",
  "aliases",
  "keywords",
  "active",
  "mappingVersion",
  "rawLanguageScope",
  "rawToken",
  "canonicalTagId",
  "mode",
  "revision",
] as const;

/**
 * The eight `action` strings the backend actually writes
 * (`admin-service.ts` / `service.ts`). Unknown values pass through verbatim
 * — see `content-view.ts`'s `taskStatusLabel` for the same rule: inventing a
 * label would hide new data, not clarify it.
 */
const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "tag.canonical.status": "更改状态",
  "tag.canonical.translations.replace": "替换译名",
  "tag.canonical.aliases.replace": "替换别名",
  "tag.canonical.keywords.replace": "替换 Keyword",
  "tag.mapping.approve": "审批映射",
  "tag.mapping.deactivate": "停用映射",
  "tag.manual.replace": "人工设置标签",
  "tag.manual.exit": "退出人工接管",
});

function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

const AUDIT_FIELD_LABELS: Readonly<Record<(typeof AUDIT_DIFF_KEYS)[number], string>> = Object.freeze({
  status: "状态",
  translations: "译名",
  aliases: "别名",
  keywords: "Keyword",
  active: "启用",
  mappingVersion: "映射版本",
  rawLanguageScope: "语言范围",
  rawToken: "Raw Token",
  canonicalTagId: "目标 Canonical Tag",
  mode: "模式",
  revision: "修订号",
});

function isLocaleDisplayNamePair(value: Record<string, unknown>): value is { locale: string; displayName: string } {
  const keys = Object.keys(value);
  return keys.length === 2 && typeof value.locale === "string" && typeof value.displayName === "string";
}

/**
 * Renders one leaf/branch from an audit `before`/`after` snapshot as
 * readable text — never a raw `JSON.stringify` dump of the whole value.
 * Arrays of primitives (e.g. `aliases`) join with `、`; `{locale,
 * displayName}` pairs (the exact shape `translations` entries take, per
 * `admin-service.ts:775`) render as `locale:displayName`; other objects
 * render as compact `key:value` pairs. Recursion is safe because the
 * snapshot itself is already depth- and length-capped upstream by
 * `projectAdminTagAuditEntry`'s `copyJson` (depth 4, arrays truncated at
 * 200).
 */
function formatAuditLeaf(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value === "" ? "(空字符串)" : value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) {
    if (value.length === 0) return "(空)";
    return value.map(formatAuditLeaf).join("、");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (isLocaleDisplayNamePair(record)) return `${record.locale}:${record.displayName}`;
    const entries = Object.entries(record);
    if (entries.length === 0) return "{}";
    return entries.map(([key, item]) => `${key}:${formatAuditLeaf(item)}`).join(", ");
  }
  return String(value);
}

/** Top-level entry point: arrays additionally get a leading item count. */
function formatAuditValue(value: unknown): string {
  if (Array.isArray(value) && value.length > 0) return `${value.length} 项：${formatAuditLeaf(value)}`;
  return formatAuditLeaf(value);
}

/**
 * `actorId` is the mutation's actor UUID, never a resolved username — the
 * projection carries no join to an admin-user table, so there is nothing
 * else to show here. Truncated to keep the compact-summary row from being
 * dominated by 36 opaque characters; the full value is still available via
 * `title`.
 */
function truncateActorId(actorId: string | null): string {
  if (!actorId) return "—";
  return actorId.length > 9 ? `${actorId.slice(0, 8)}…` : actorId;
}

function auditDiffRows(
  entry: AdminTagAuditEntryView,
): ReadonlyArray<{ key: (typeof AUDIT_DIFF_KEYS)[number]; before: unknown; after: unknown }> {
  const { before, after } = entry;
  if (!before && !after) return [];
  const rows: { key: (typeof AUDIT_DIFF_KEYS)[number]; before: unknown; after: unknown }[] = [];
  for (const key of AUDIT_DIFF_KEYS) {
    const inBefore = before ? Object.prototype.hasOwnProperty.call(before, key) : false;
    const inAfter = after ? Object.prototype.hasOwnProperty.call(after, key) : false;
    if (!inBefore && !inAfter) continue;
    rows.push({ key, before: inBefore ? before![key] : undefined, after: inAfter ? after![key] : undefined });
  }
  return rows;
}

/**
 * One audit entry's compact summary: action chip, timestamp, actor, reason,
 * and — when the entry carries a snapshot — a per-field `{label}：{before} →
 * {after}` diff underneath.
 *
 * `reason` renders `—` whenever it is `null`, which today is *always*
 * (P2-06.5 F5, still open — none of the eight mutation routes' `exactKeys`
 * currently accepts a `reason`). That is the expected steady state, not a
 * missing-data warning, so this never renders an error or "N/A" tone for it.
 */
export function TagAuditEntryRow({
  entry,
  testId,
}: {
  entry: AdminTagAuditEntryView;
  testId?: string;
}) {
  const rows = auditDiffRows(entry);
  return (
    <div className="space-y-1 px-3 py-2 text-xs" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2 text-gray-600">
        <span
          className="rounded-full bg-gray-100 px-2 py-0.5 font-medium text-gray-700"
          data-testid={testId ? `${testId}-action` : undefined}
        >
          {auditActionLabel(entry.action)}
        </span>
        <span className="text-gray-400">{formatDateTime(entry.createdAt)}</span>
        <span
          className="font-mono text-gray-400"
          title={entry.actorId ?? undefined}
          data-testid={testId ? `${testId}-actor` : undefined}
        >
          操作人 {truncateActorId(entry.actorId)}
        </span>
        <span className="text-gray-400" data-testid={testId ? `${testId}-reason` : undefined}>
          原因 {entry.reason ?? "—"}
        </span>
      </div>
      {rows.length > 0 && (
        <ul className="space-y-0.5 pl-1 text-gray-600" data-testid={testId ? `${testId}-diff` : undefined}>
          {rows.map((row) => (
            <li key={row.key}>
              {AUDIT_FIELD_LABELS[row.key]}：{formatAuditValue(row.before)} → {formatAuditValue(row.after)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A scrollable list of audit entries — CPS parity for `home-carousel`'s
 * 操作日志 section (`max-h-96 overflow-y-auto`). Entries render in the order
 * given (the backend already orders by `createdAt desc`; this component
 * does not re-sort).
 */
export function TagAuditLog({
  entries,
  testId = "tag-audit-log",
  emptyLabel = "暂无变更记录",
}: {
  entries: readonly AdminTagAuditEntryView[];
  testId?: string;
  emptyLabel?: string;
}) {
  return (
    <div className="max-h-96 overflow-y-auto rounded-lg border border-gray-200 bg-white" data-testid={testId}>
      {entries.length === 0 ? (
        <p className="px-3 py-6 text-center text-gray-400" data-testid={`${testId}-empty`}>
          {emptyLabel}
        </p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {entries.map((entry, index) => (
            <li key={`${entry.action}-${entry.createdAt}-${index}`}>
              <TagAuditEntryRow entry={entry} testId={`${testId}-item-${index}`} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
