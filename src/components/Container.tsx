import type { ReactNode } from "react";

/**
 * 内容宽度容器。最大宽度走 --novel-content-max，两侧留白按移动优先给。
 * 阅读正文不用这个容器——它有自己的行长约束（--reader-measure）。
 */
export function Container({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "header" | "footer" | "section" | "nav" | "main";
}) {
  return (
    <Tag
      className={`mx-auto w-full px-5 md:px-8 ${className}`}
      style={{ maxWidth: "var(--novel-content-max)" }}
    >
      {children}
    </Tag>
  );
}
