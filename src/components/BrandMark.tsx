/**
 * 品牌占位。
 *
 * 正式 Logo 尚未交付。本轮使用固定尺寸槽位 + 一个无品牌含义的几何标记
 * （圆角方形 + 内嵌竖条，纯几何，不表意），配文字占位符 BRAND_PLACEHOLDER。
 *
 * 🔴 正式 Logo 到位后，**只替换标记资产与文字，不重构页头**。
 * 因此槽位是固定尺寸的方形容器，标记以何种形式填充与布局无关。
 *
 * 🔴 禁止：自行生成正式 Logo；用 emoji 当 Logo；因占位标记而做出不可逆布局决定。
 *
 * 16 / 24 / 32 / 40 四档尺寸全部预留。页头用 32，页脚用 24。
 */
export const BRAND_PLACEHOLDER_TEXT = "BRAND_PLACEHOLDER";

export const BRAND_MARK_SIZES = [16, 24, 32, 40] as const;
export type BrandMarkSize = (typeof BRAND_MARK_SIZES)[number];

/** 只有标记本身。槽位尺寸固定，正式资产替换时不影响任何布局。 */
export function BrandMark({
  size = 32,
  className = "",
}: {
  size?: BrandMarkSize;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      data-brand-slot="mark"
      data-brand-slot-size={size}
      aria-hidden="true"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        focusable="false"
      >
        <rect
          x="2"
          y="2"
          width="28"
          height="28"
          rx="7"
          stroke="currentColor"
          strokeWidth="2"
          className="text-novel-border-strong"
        />
        <rect
          x="11"
          y="9"
          width="3"
          height="14"
          rx="1.5"
          fill="currentColor"
          className="text-novel-primary"
        />
        <rect
          x="18"
          y="9"
          width="3"
          height="14"
          rx="1.5"
          fill="currentColor"
          className="text-novel-fg-subtle"
        />
      </svg>
    </span>
  );
}

/** 标记 + 字标。作为整体的品牌入口。 */
export function BrandLockup({
  size = 32,
  href,
  className = "",
}: {
  size?: BrandMarkSize;
  href?: string;
  className?: string;
}) {
  const content = (
    <>
      <BrandMark size={size} />
      <span
        className="font-novel-serif text-base font-semibold tracking-tight text-novel-fg"
        data-brand-slot="wordmark"
      >
        {BRAND_PLACEHOLDER_TEXT}
      </span>
    </>
  );

  const classes = `inline-flex items-center gap-2.5 ${className}`;

  if (href) {
    return (
      <a href={href} className={`${classes} transition-opacity hover:opacity-80`}>
        {content}
      </a>
    );
  }

  return <span className={classes}>{content}</span>;
}
