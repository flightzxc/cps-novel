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
  spacingClassName = "mb-6 md:mb-8",
}: {
  title: string;
  /** 右侧文字型入口，比如「查看全部」。没有就不渲染。 */
  action?: ReactNode;
  /** 标题下方的一行说明，比如可试读章节的计数口径。 */
  description?: ReactNode;
  headingLevel?: 2 | 3;
  id?: string;
  /**
   * 标题块到下方内容的距离。默认是全站口径（24 / 32px）。
   *
   * 留这个出口只为首页首屏：那一屏的每一段留白都在跟「第一排书卡露多少」
   * 抢像素，需要比常规页面紧一档。其余调用点一律不传，保持全站一致——
   * 不要把它当成「这里想松一点就传一个」的通用旋钮。
   */
  spacingClassName?: string;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <div className={spacingClassName}>
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
