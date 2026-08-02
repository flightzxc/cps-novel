/**
 * 封面。
 *
 * 两条设计约束：
 *   1. 比例只能来自 --novel-cover-aspect，组件里**不得**出现 3/4 或 2/3 这样的字面值。
 *      真实上游封面资产尚未量过，改比例时只改 globals.css 那一行。
 *   2. 封面是全站唯一允许高饱和的区域。外面加一道极细内描边，让它看起来是「一个
 *      有厚度的物件」而不是「一块贴上去的图」——这是与短剧站海报网格的区隔点之一。
 *
 * 缺图时渲染占位块而不是隐藏——卡片的版面节奏不能因为一本书没封面就塌掉。
 */
export function CoverImage({
  src,
  alt,
  className = "",
  sizeHint,
}: {
  src?: string;
  /** 无障碍替代文本。装饰性使用时传空字符串。 */
  alt: string;
  className?: string;
  /** 传给浏览器的尺寸提示，纯性能用途 */
  sizeHint?: string;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-novel-md bg-novel-bg-raised ${className}`}
      style={{ aspectRatio: "var(--novel-cover-aspect)" }}
    >
      {src ? (
        // 本轮只渲染 MOCK_ONLY 的内联占位图，用原生 img 即可；
        // 真实封面的来源、尺寸与优化策略属于内容阶段，本轮不预设。
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          sizes={sizeHint}
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div
          aria-hidden="true"
          className="flex h-full w-full items-center justify-center"
        >
          {/* 无封面占位：一条极简的书脊示意，不表意、不含品牌信息 */}
          <svg
            width="28"
            height="36"
            viewBox="0 0 28 36"
            fill="none"
            className="text-novel-fg-subtle opacity-50"
          >
            <rect
              x="1"
              y="1"
              width="26"
              height="34"
              rx="2"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path d="M8 1v34" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </div>
      )}
      {/* 内描边：不占布局，只给封面一个边界 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-novel-md ring-1 ring-inset ring-novel-border"
      />
    </div>
  );
}
