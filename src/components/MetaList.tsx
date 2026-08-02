import type { ReactNode } from "react";

/**
 * 元信息行：流式、自适应，**只渲染当前真实存在的字段**。
 *
 * 有几项排几项，中间用细分隔点；一项也没有时整行不渲染。
 *
 * 🔴 流式的理由不是「将来加字段方便」——本项目明确不为任何未知字段预留固定槽位。
 * 理由只有一个：不同的书在同一时刻拥有的字段就可能不同，版面必须对「少一项」
 * 是自然的，而不是留出一个空洞。
 *
 * 传进来的项里出现 null / undefined / 空串会被丢掉，不会渲染成空位。
 */
export interface MetaItem {
  key: string;
  value: ReactNode;
}

export function MetaList({
  items,
  className = "",
}: {
  items: (MetaItem | null | undefined | false)[];
  className?: string;
}) {
  const present = items.filter(
    (item): item is MetaItem =>
      Boolean(item) && item !== null && typeof item === "object" && item.value !== null && item.value !== undefined && item.value !== "",
  );

  if (present.length === 0) {
    return null;
  }

  return (
    <ul
      className={`flex list-none flex-wrap items-center gap-x-3 gap-y-1 p-0 text-sm text-novel-fg-subtle ${className}`}
      data-testid="meta-list"
    >
      {present.map((item, index) => (
        <li key={item.key} className="flex items-center gap-3">
          {index > 0 ? (
            <span aria-hidden="true" className="text-novel-border-strong">
              ·
            </span>
          ) : null}
          <span>{item.value}</span>
        </li>
      ))}
    </ul>
  );
}
