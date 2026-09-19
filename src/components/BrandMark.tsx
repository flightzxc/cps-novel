/**
 * PulseNovel 品牌标记。
 *
 * `BrandMark` 是正式字标：Owner 拍板的中间变体（单条 path，来源见
 * `.brand-assets/pulsenovel-mark.svg`，已与源位图逐像素比对过），不是几何占位。
 * `BrandLockup` 是「标记 + 站点品牌名」的整体入口，二者组合是
 * `[黄色字标] PulseNovel` 这种「图标 + 字标」排布（参照 FlickReels 的组织方式，
 * 不复用它的图形/字体/组件）。
 *
 * 槽位仍是固定尺寸的方形容器——这条纪律从占位阶段延续下来：标记以何种资产
 * 填充与页头/页脚布局无关，换资产不该牵动布局。16 / 24 / 32 / 40 四档尺寸全部
 * 预留，页头用 32，页脚用 24。
 *
 * 🔴 禁止重新设计这个字形（不改 path 数据、不换字体）；着色一律走
 * `--novel-accent`（品牌黄），不写字面色值——组件树受
 * tests/ui/no-hardcoded-colors.test.ts 约束，颜色只能来自
 * src/styles/globals.css 的 token。
 *
 * 是否加圆角底板：不加。这是实心字形（`P` 的负空间已经是字形的一部分），
 * 底板会在 16/24px 这两档小尺寸下把负空间糊成一块黄色方块，反而认不出是
 * 字标；直接输出黄色字标本身，在深色页头上已经足够醒目。2026-09-19 品牌
 * 接入时由实现方按上述理由自行判定，Owner 未就底板单独表态——需要改成
 * 带底板时，这是一处可以直接推翻的决定，不必当成已冻结的口径。
 * （Owner 明确拍板过的只有两条：字标用中间那个变体、品牌黄 = #FED405。）
 */
export const BRAND_MARK_SIZES = [16, 24, 32, 40] as const;
export type BrandMarkSize = (typeof BRAND_MARK_SIZES)[number];

/**
 * 站点品牌名缺失或全是空白时的占位符。语义是「这里还没配」——保留这条语义
 * 是刻意的：即使本轮把品牌定为 PulseNovel，`SiteSetting.siteName` 仍是唯一
 * 真源（见 `chromeFromSiteSetting`），这里不能因为知道最终品牌名就硬编码成
 * "PulseNovel" 去绕过「品牌名是运营配置项」这条架构事实。
 */
export const BRAND_PLACEHOLDER_TEXT = "BRAND_PLACEHOLDER";

/** 只有标记本身。槽位尺寸固定，换资产不影响任何布局。 */
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
        viewBox="0 0 342 403"
        fill="none"
        focusable="false"
        className="text-novel-accent"
      >
        <path
          fill="currentColor"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M105.5,402.88 L-0.12,402.75 L-0.12,1.5 L1.25,-0.12 L209.5,-0.12 L211.25,0.62 L221.5,1.12 L222.5,1.62 L230.5,2.12 L232.25,2.88 L240.5,3.88 L241.5,4.62 L244.5,4.88 L258.5,8.88 L269.0,12.88 L278.5,17.12 L285.25,20.88 L294.25,26.88 L307.5,37.88 L313.88,44.75 L322.62,56.0 L328.88,67.0 L333.88,78.5 L336.62,86.75 L336.88,89.0 L337.88,91.0 L338.88,98.0 L339.88,100.0 L339.88,102.5 L340.38,103.5 L340.12,105.0 L340.88,107.0 L340.88,110.5 L341.88,111.75 L341.88,148.0 L340.88,150.0 L340.38,158.0 L339.88,158.75 L339.62,162.25 L338.88,163.75 L338.62,168.5 L337.12,173.25 L337.38,174.25 L336.88,176.75 L335.88,179.0 L335.88,180.5 L335.12,182.0 L333.88,188.25 L328.62,205.25 L327.62,206.75 L324.62,215.25 L314.88,234.75 L305.62,250.0 L298.38,260.25 L292.62,267.75 L280.88,281.0 L263.0,297.88 L257.75,301.88 L255.25,304.38 L244.25,312.62 L224.25,326.38 L214.0,332.62 L205.25,338.62 L193.0,345.62 L171.5,358.88 L165.0,362.12 L155.75,367.88 L151.0,370.12 L145.25,373.88 L138.0,377.88 L136.5,377.62 L135.88,374.5 L136.12,205.25 L138.75,203.12 L149.75,202.88 L152.25,202.12 L159.75,201.88 L162.0,201.12 L172.25,200.12 L182.0,197.62 L193.0,193.38 L199.25,189.88 L206.5,184.62 L214.62,176.75 L216.62,174.25 L221.88,166.25 L225.88,157.75 L228.88,146.5 L229.12,141.25 L229.88,139.75 L229.88,128.25 L229.38,126.75 L229.38,122.25 L228.88,121.25 L228.88,119.0 L228.12,117.25 L227.88,114.5 L225.88,108.25 L223.62,103.25 L219.12,96.25 L213.25,90.12 L209.25,86.88 L204.75,84.12 L198.0,81.12 L189.0,78.38 L176.25,76.62 L106.0,76.88 L105.62,77.5 L105.5,402.88 Z M175.88,307.25 L189.5,301.62 L202.25,295.38 L228.75,280.12 L241.0,271.88 L254.5,261.62 L265.25,252.12 L271.62,245.75 L279.62,237.0 L287.12,227.5 L291.62,221.25 L300.88,205.5 L309.62,186.25 L310.62,182.25 L315.12,169.75 L316.62,163.25 L316.5,161.62 L315.62,162.0 L308.62,170.25 L301.5,177.38 L292.0,184.62 L278.75,193.12 L271.0,196.88 L269.75,197.88 L254.5,204.88 L239.25,210.62 L227.5,214.12 L221.5,215.38 L220.0,216.12 L214.0,217.12 L212.25,217.88 L209.25,218.12 L207.75,218.88 L205.25,218.88 L202.25,219.88 L200.0,219.88 L198.25,220.62 L192.75,221.12 L191.25,221.88 L189.5,221.62 L187.75,222.12 L184.5,222.12 L182.0,222.88 L175.25,223.12 L174.38,224.0 L174.62,296.75 L174.12,306.5 L174.75,307.38 L175.88,307.25 Z"
        />
      </svg>
    </span>
  );
}

/**
 * 标记 + 字标。作为整体的品牌入口。
 *
 * `name` 是站点品牌名（来自 `SiteSetting.siteName`）。🔴 缺失或 trim 后为空时
 * 仍渲染 `BRAND_PLACEHOLDER_TEXT`——这是刻意保留的可见信号：未配置品牌名时，
 * 页头应该看得出「这里还没配」，而不是安静地留白或另造一个「更好看」的默认名。
 */
export function BrandLockup({
  size = 32,
  href,
  name,
  className = "",
}: {
  size?: BrandMarkSize;
  href?: string;
  /** 站点品牌名。缺失或全是空白时回落到占位符。 */
  name?: string;
  className?: string;
}) {
  const wordmark = name?.trim() || BRAND_PLACEHOLDER_TEXT;
  const content = (
    <>
      <BrandMark size={size} />
      <span
        className="font-novel-serif text-base font-semibold tracking-tight text-novel-fg"
        data-brand-slot="wordmark"
      >
        {wordmark}
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
