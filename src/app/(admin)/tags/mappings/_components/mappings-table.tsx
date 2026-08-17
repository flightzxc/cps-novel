import { buttonClassName } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { StatusBadge } from "@/components/ui/status-badge";
import type { AdminSourceLabelMappingView } from "@/contracts";
import { formatDateTime } from "@/features/admin-ui/content-view";

import { TagAuditEntryRow } from "../../_components/tag-audit-log";
import { RawIdentity } from "./raw-token";

type MappingGroup = {
  readonly key: string;
  readonly channel: AdminSourceLabelMappingView["channel"];
  readonly rawLanguageScope: string;
  readonly rawToken: string;
  readonly edges: readonly AdminSourceLabelMappingView[];
};

/**
 * Groups by `(channelAppId, rawLanguageScope, rawToken)` — the DB unique key
 * also includes `canonicalTagId` (`source_label_mapping_identity_key`), so
 * one raw token in one scope on one channel app can legitimately point at
 * several canonical tags, each its own edge row. Without this grouping the
 * table would show N confusingly near-identical rows for what is really one
 * source identity fanning out to N targets.
 *
 * The key is `JSON.stringify` of the tuple, not a string join. `rawToken`
 * and `rawLanguageScope` are untouched upstream bytes this page explicitly
 * promises never to normalise — a naive `${a}:${b}:${c}` join would fold two
 * distinct identities into one group the moment either field happened to
 * contain the join character, which is exactly the kind of silent merge
 * this screen exists to prevent.
 *
 * Grouping only ever looks at the rows on the current page; a group that
 * would otherwise span a pagination boundary renders as two groups. That is
 * a display artefact of pagination, not a data error — every row's own
 * identity is still shown byte-exact regardless of which group it lands in.
 */
function groupMappings(items: readonly AdminSourceLabelMappingView[]): MappingGroup[] {
  const order: string[] = [];
  const groups = new Map<string, MappingGroup>();
  for (const item of items) {
    const key = JSON.stringify([item.channel.channelAppId, item.rawLanguageScope, item.rawToken]);
    const existing = groups.get(key);
    if (existing) {
      groups.set(key, { ...existing, edges: [...existing.edges, item] });
    } else {
      order.push(key);
      groups.set(key, {
        key,
        channel: item.channel,
        rawLanguageScope: item.rawLanguageScope,
        rawToken: item.rawToken,
        edges: [item],
      });
    }
  }
  return order.map((key) => groups.get(key)!);
}

export function MappingsTable({
  items,
  canManage,
  busy,
  onReapprove,
  onDeactivate,
}: {
  items: readonly AdminSourceLabelMappingView[];
  canManage: boolean;
  busy: boolean;
  onReapprove: (row: AdminSourceLabelMappingView) => void;
  onDeactivate: (row: AdminSourceLabelMappingView) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-6 py-16 text-center shadow-sm">
        <p className="text-gray-400">没有符合条件的映射</p>
      </div>
    );
  }

  const groups = groupMappings(items);

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200 bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-gray-500">渠道</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">语言范围 / Raw Token</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">目标 Canonical Tag</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">映射版本</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">审批</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">更新时间</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">最近变更</th>
            {canManage && (
              <th className="px-4 py-3 text-right font-medium text-gray-500">
                <span className="sr-only">操作</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {groups.map((group) =>
            group.edges.map((edge, index) => {
              const anchor = group.edges[0].id;
              return (
                <tr key={edge.id} data-testid={`mapping-row-${edge.id}`} className="hover:bg-gray-50">
                  {index === 0 && (
                    <td
                      rowSpan={group.edges.length}
                      className="border-r border-gray-100 px-4 py-3 align-top"
                    >
                      <div className="font-medium text-gray-900">{group.channel.channelCode}</div>
                      <div className="text-xs text-gray-500">{group.channel.sourceAppCode}</div>
                      <div className="mt-1 flex items-center gap-1 text-xs text-gray-400">
                        <span className="break-all font-mono" title="channelAppId">
                          {group.channel.channelAppId}
                        </span>
                        <CopyButton value={group.channel.channelAppId} label="复制 ID" />
                      </div>
                      {!group.channel.active && (
                        <div className="mt-1">
                          <StatusBadge tone="neutral">渠道已停用</StatusBadge>
                        </div>
                      )}
                    </td>
                  )}
                  {index === 0 && (
                    <td
                      rowSpan={group.edges.length}
                      className="border-r border-gray-100 px-4 py-3 align-top"
                    >
                      <RawIdentity
                        scope={group.rawLanguageScope}
                        token={group.rawToken}
                        scopeTestId={`mapping-scope-${anchor}`}
                        tokenTestId={`mapping-token-${anchor}`}
                      />
                      {group.edges.length > 1 && (
                        <p
                          className="mt-1 text-xs text-blue-600"
                          data-testid={`mapping-group-count-${anchor}`}
                        >
                          1 个来源标签 → {group.edges.length} 个 canonical tag
                        </p>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3" data-testid={`mapping-target-${edge.id}`}>
                    <span className="break-all font-mono text-gray-900">{edge.target.slug}</span>
                    {!edge.target.active && (
                      <span className="ml-2 inline-block">
                        <StatusBadge tone="neutral" title="目标 Canonical Tag 已停用">
                          已停用
                        </StatusBadge>
                      </span>
                    )}
                    <div className="mt-1 flex items-center gap-1 text-xs text-gray-400">
                      <span className="break-all font-mono">{edge.target.id}</span>
                      <CopyButton value={edge.target.id} label="复制 ID" />
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{edge.mappingVersion}</td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={edge.active ? "success" : "neutral"}>
                      {edge.active ? "生效中" : "已停用"}
                    </StatusBadge>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    <div>{edge.approvedBy.username}</div>
                    <div className="text-gray-400">{formatDateTime(edge.approvedAt)}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{formatDateTime(edge.updatedAt)}</td>
                  <td className="px-2 py-1 text-xs" data-testid={`mapping-last-mutation-${edge.id}`}>
                    {edge.lastMutation ? (
                      <TagAuditEntryRow entry={edge.lastMutation} testId={`mapping-last-mutation-entry-${edge.id}`} />
                    ) : (
                      <span className="px-1 text-gray-400">暂无变更记录</span>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          className={buttonClassName("secondary", "px-2 py-1 text-xs")}
                          onClick={() => onReapprove(edge)}
                          data-testid={`mapping-reapprove-${edge.id}`}
                        >
                          {edge.active ? "重新审批" : "重新启用"}
                        </button>
                        {edge.active && (
                          <button
                            type="button"
                            disabled={busy}
                            className={buttonClassName("danger", "px-2 py-1 text-xs")}
                            onClick={() => onDeactivate(edge)}
                            data-testid={`mapping-deactivate-${edge.id}`}
                          >
                            停用
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
    </div>
  );
}
