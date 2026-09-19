import Link from "next/link";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ComponentProps,
  ReactNode,
} from "react";

/**
 * 行动按钮。
 *
 * PulseNovel 品牌接入（2026-09-19，Owner 决策，推翻了下面这条原本写在这里的
 * 区隔点声明）：主按钮改为暖黄填充 + 接近胶囊的大圆角
 * （--novel-radius-pill，见 globals.css）。
 *
 * 历史记录，免得以后有人诧异「怎么和注释说的不一样」：这条组件最初的设计
 * 主张是「视觉方向『墨与纸』：主按钮是一块纸色填充，压深墨色的字——不是高
 * 饱和胶囊；圆角用中等档，没有全圆角，全圆角是 App 商店语言，中等圆角矩形
 * 是出版物语言，这是刻意的区隔点」。品牌接入把配色从纸色换成品牌黄之后，
 * Owner 认为高饱和暖黄 CTA 更适合搭配一个明确的「主按钮」形状锚点，因此只
 * 对 accent 档单独放开胶囊圆角——outline / quiet 两档维持中等圆角不变，两种
 * 圆角并存反而让主次关系更清楚（胶囊 = 这一屏最重的动作，矩形 = 次级动作）。
 * 不做这条决策的地方：没有把胶囊圆角扩散到别的组件，没有引入渐变或炫彩效果。
 *
 * 三个层级：
 *   accent   品牌黄填充，胶囊圆角。页面上最重的动作，一屏原则上只出现一次。
 *   outline  描边式，中等圆角。边框用 --novel-border-strong（对比度 3.48:1，满足非文本 3:1）。
 *   quiet    无边框弱化动作，中等圆角。
 */
export type ButtonVariant = "accent" | "outline" | "quiet";
export type ButtonSize = "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 font-medium " +
  "transition-colors select-none whitespace-nowrap " +
  "disabled:opacity-45 disabled:pointer-events-none active:brightness-95";

const VARIANTS: Record<ButtonVariant, string> = {
  accent:
    "bg-novel-accent text-novel-on-accent hover:bg-novel-accent-hover " +
    "border border-transparent rounded-novel-pill",
  outline:
    "bg-transparent text-novel-fg border border-novel-border-strong " +
    "hover:bg-novel-bg-raised rounded-novel-md",
  quiet:
    "bg-transparent text-novel-fg-muted border border-transparent " +
    "hover:text-novel-fg hover:bg-novel-bg-raised rounded-novel-md",
};

const SIZES: Record<ButtonSize, string> = {
  md: "text-sm px-4 py-2.5",
  lg: "text-base px-6 py-3.5",
};

function classesFor(variant: ButtonVariant, size: ButtonSize, extra: string) {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${extra}`;
}

type CommonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
};

export function Button({
  variant = "outline",
  size = "md",
  className = "",
  children,
  ...rest
}: CommonProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={classesFor(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}

/**
 * 链接形态的按钮。
 * 用 <a> 而不是 <button> 是因为这些动作全部是导航——站内试读入口与站外正式
 * 阅读入口都要能被中键打开、被右键复制地址、被键盘回车触发。
 */
export function ButtonLink({
  variant = "outline",
  size = "md",
  className = "",
  children,
  ...rest
}: CommonProps & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={classesFor(variant, size, className)} {...rest}>
      {children}
    </a>
  );
}

/**
 * 站内导航形态的按钮：与 ButtonLink 视觉完全一致，但走客户端路由。
 *
 * 用途限站内地址。站外入口（正式阅读跳转）必须继续用 ButtonLink——那是真正的
 * 离站导航，走客户端路由既没有意义，也会让 rel="nofollow sponsored" 的语义变模糊。
 *
 * 可以留在 server component 里：next/link 自身不需要 "use client"。
 * 在没有 App Router 上下文的环境（如 jsdom 单测）里，Link 的每处 router 调用
 * 都有 null 守卫，会退化成一个普通 <a>，因此不需要为测试准备 router mock。
 */
export function ButtonNavLink({
  variant = "outline",
  size = "md",
  className = "",
  children,
  ...rest
}: CommonProps & ComponentProps<typeof Link>) {
  return (
    <Link className={classesFor(variant, size, className)} {...rest}>
      {children}
    </Link>
  );
}
