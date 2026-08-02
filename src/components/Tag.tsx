import type { SiteTag } from "@/features/public-ui/types";

/**
 * 站点标签。
 *
 * 🔴 只有明确允许公开的站点标签才能进这里，原始来源标签不得直接展示。
 * 🔴 标签为空时，调用方必须让**整个标签区块消失**——不留标题、不留空框、
 *    不留占位 chip。TagList 对空数组返回 null 就是为了让这条难以违反。
 */
export function Tag({ tag }: { tag: SiteTag }) {
  const className =
    "inline-flex items-center rounded-novel-sm bg-novel-bg-raised px-2.5 py-1 " +
    "text-xs text-novel-fg-muted";

  if (tag.href) {
    return (
      <a href={tag.href} className={`${className} hover:text-novel-fg transition-colors`}>
        {tag.label}
      </a>
    );
  }

  return <span className={className}>{tag.label}</span>;
}

export function TagList({
  tags,
  className = "",
  label,
}: {
  tags: SiteTag[];
  className?: string;
  /** 屏幕阅读器用的区域名。视觉上不出现标题——标签自己就说明了自己。 */
  label?: string;
}) {
  if (tags.length === 0) {
    return null;
  }

  return (
    <ul
      aria-label={label}
      className={`flex list-none flex-wrap gap-2 p-0 ${className}`}
      data-testid="tag-list"
    >
      {tags.map((tag) => (
        <li key={tag.slug}>
          <Tag tag={tag} />
        </li>
      ))}
    </ul>
  );
}
