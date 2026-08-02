import { ButtonLink } from "@/components/Button";

/**
 * 上一章 / 下一章。
 *
 * 边界处按钮不渲染（而不是渲染成禁用的链接）——一个不能去任何地方的链接对键盘
 * 和读屏用户是噪音。首尾位置用一句说明代替，让用户知道是到头了而不是坏了。
 *
 * 本轮是普通链接跳转；P1-11 会把它换成客户端路由以做到章节切换不整页刷新，
 * 届时只需替换这个组件内部的导航方式，调用方不变。
 */
export function ChapterPager({
  previousHref,
  nextHref,
  className = "",
}: {
  previousHref?: string;
  nextHref?: string;
  className?: string;
}) {
  return (
    <nav
      aria-label="章节导航"
      className={`flex items-center justify-between gap-3 ${className}`}
      data-testid="chapter-pager"
    >
      {previousHref ? (
        <ButtonLink href={previousHref} variant="outline" rel="prev">
          上一章
        </ButtonLink>
      ) : (
        <span className="text-sm text-novel-fg-subtle">已是第一章</span>
      )}

      {nextHref ? (
        <ButtonLink href={nextHref} variant="outline" rel="next">
          下一章
        </ButtonLink>
      ) : (
        <span className="text-sm text-novel-fg-subtle">已是最后一章试读</span>
      )}
    </nav>
  );
}
