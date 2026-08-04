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

/**
 * 色调。默认第三级文本；压在主视觉图上时用 on-media（更亮，因为底下是不可控图像）。
 * 做成显式开关而不是让调用方用 className 覆盖——覆盖依赖工具类在样式表里的先后
 * 顺序，不可靠。
 */
export type MetaTone = "subtle" | "on-media";

const TONE: Record<MetaTone, string> = {
  subtle: "text-novel-fg-subtle",
  "on-media": "text-novel-fg-muted-on-media",
};

export function MetaList({
  items,
  className = "",
  tone = "subtle",
}: {
  items: (MetaItem | null | undefined | false)[];
  className?: string;
  tone?: MetaTone;
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
      className={`flex list-none flex-wrap items-center gap-x-3 gap-y-1 p-0 text-sm ${TONE[tone]} ${className}`}
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
