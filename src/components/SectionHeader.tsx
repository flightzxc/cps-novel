import type { ReactNode } from "react";

/**
 * 区块小标题。
 *
 * 🔴 不用 emoji 装饰。四个竞品的小标题全部是 🔥 / 🚀 开头，这是本品类最省力的
 * 区隔点：我们的小标题只有文字，右侧可选一个文字型入口，下方一条细规线。
 */
export function SectionHeader({
  title,
  action,
  description,
  headingLevel = 2,
  id,
}: {
  title: string;
  /** 右侧文字型入口，比如「查看全部」。没有就不渲染。 */
  action?: ReactNode;
  /** 标题下方的一行说明，比如可试读章节的计数口径。 */
  description?: ReactNode;
  headingLevel?: 2 | 3;
  id?: string;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <div className="mb-6 md:mb-8">
      <div className="flex items-baseline justify-between gap-4 border-b border-novel-border pb-3">
        <Heading
          id={id}
          className="font-novel-serif text-xl font-semibold tracking-tight text-novel-fg md:text-2xl"
        >
          {title}
        </Heading>
        {action ? <div className="shrink-0 text-sm">{action}</div> : null}
      </div>
      {description ? (
        <p className="mt-3 text-sm text-novel-fg-subtle">{description}</p>
      ) : null}
    </div>
  );
}
