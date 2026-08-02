import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

/**
 * 行动按钮。
 *
 * 视觉方向「墨与纸」：主按钮是一块纸色填充，压深墨色的字——不是高饱和胶囊。
 * 圆角用中等档（--novel-radius-md），**没有全圆角**：全圆角是 App 商店语言，
 * 中等圆角矩形是出版物语言，这是刻意的区隔点。
 *
 * 三个层级：
 *   accent   纸色填充。页面上最重的动作，一屏原则上只出现一次。
 *   outline  描边式。边框用 --novel-border-strong（对比度 3.48:1，满足非文本 3:1）。
 *   quiet    无边框弱化动作。
 */
export type ButtonVariant = "accent" | "outline" | "quiet";
export type ButtonSize = "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 font-medium " +
  "transition-colors select-none whitespace-nowrap " +
  "disabled:opacity-45 disabled:pointer-events-none";

const VARIANTS: Record<ButtonVariant, string> = {
  accent:
    "bg-novel-accent text-novel-on-accent hover:bg-novel-accent-hover " +
    "border border-transparent",
  outline:
    "bg-transparent text-novel-fg border border-novel-border-strong " +
    "hover:bg-novel-bg-raised",
  quiet:
    "bg-transparent text-novel-fg-muted border border-transparent " +
    "hover:text-novel-fg hover:bg-novel-bg-raised",
};

const SIZES: Record<ButtonSize, string> = {
  md: "text-sm px-4 py-2.5",
  lg: "text-base px-6 py-3.5",
};

function classesFor(variant: ButtonVariant, size: ButtonSize, extra: string) {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]} rounded-novel-md ${extra}`;
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
