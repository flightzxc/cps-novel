import { ButtonLink } from "@/components/Button";
import { BrandLockup } from "@/components/BrandMark";
import { CoverImage } from "@/components/CoverImage";
import { codeModeCopy } from "@/lib/locale/code-mode-copy";

import { CopyCodeButton } from "./CopyCodeButton";

/**
 * 口令码模式中间页（v0.6.0，Owner 10-14 拍板第 1 项的设计稿三块画板：手机中间页、电脑中间页；书页按钮在
 * `NovelDetailScreen`）。读者从书页 / 文章 / 章节页的"Read on PlotNovel App"按钮点进来：
 * 书名 + 封面、**大号口令码 + 复制按钮**、三步说明（手机）或一句话说明（电脑）、App Store / Google Play 按钮、底部免责小字。
 *
 * 🔴 这是整个站点里**唯一**会出现渠道真实口令码的地方：书页 / 文章页 / 章节页的 HTML、站点地图、日志里都没有它。
 * 钉着它的用例：`tests/backend/public/code-mode-leak.test.ts`（详情 / 卡片视图模型里没有口令码字段）、
 * `tests/ui/code-mode-entry-buttons.test.tsx` 的"渠道真实口令码不进书页 / 章节页的 HTML"（整页渲染结果）、
 * `tests/backend/public/go-redirect.test.ts`（`/go/<站内码>` 路由从不读、也不输出口令码）；站点地图与调度器
 * 靠列级授权兜底（`scheduler_app` 读不到 `upstream_code`，见 `infra/postgres/grants.sql`）。页面位于 `/go/` 之下
 * （robots 已禁止抓取）、`noindex, nofollow`、不缓存（动态渲染，Next 对动态页统一发 `no-store`）。
 *
 * 商店链接按剧场配置，所有书共用（Owner 拍板第 2 项）：两个都没配 → 不渲染按钮，改显示一句
 * `Search "PlotNovel" in your app store`；缺哪个就不渲染哪个。链接已在 `normalizeStoreUrl` 里只放行 https。
 *
 * 版式：手机 / 电脑同一份 DOM、靠断点切换（`md:`）。默认"三步版"——手机显示三步说明，电脑显示一句话说明
 * （设计稿两块画板就是这样分的）。颜色全部来自 `--novel-*` token，按钮用项目现有的 `ButtonLink`。
 */
export function CodeModeInterstitial({
  brandName,
  appName,
  title,
  coverUrl,
  code,
  backHref,
  appStoreUrl,
  googlePlayUrl,
}: {
  brandName: string;
  appName: string;
  title: string;
  coverUrl?: string;
  /** 渠道真实口令码——只在这里渲染。 */
  code: string;
  /** 回到书页的站内路径；不知道（文章已下线等）就不渲染返回链接。 */
  backHref?: string;
  appStoreUrl: string | null;
  googlePlayUrl: string | null;
}) {
  const copy = codeModeCopy(appName).interstitial;
  const hasStoreLink = Boolean(appStoreUrl || googlePlayUrl);

  return (
    <div className="flex min-h-dvh flex-col bg-novel-bg text-novel-fg" data-testid="code-mode-interstitial">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-novel-border px-5 md:h-16 md:px-12">
        <BrandLockup size={24} href="/" name={brandName} />
        {backHref ? (
          <a href={backHref} className="inline-flex items-center gap-1 text-sm text-novel-fg-muted transition-colors hover:text-novel-fg" data-testid="code-mode-back">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            {copy.backToBook}
          </a>
        ) : null}
      </header>

      <main className="flex flex-1 flex-col px-5 pt-6 pb-5 md:justify-center md:px-12 md:py-10">
        {/* 设计稿：电脑版内容区宽 960（两侧各 48 的页边距在外面），左 280 + 间距 64 + 右 616 */}
        <div className="mx-auto flex w-full max-w-[960px] flex-1 flex-col gap-5 md:grid md:flex-none md:grid-cols-[280px_minmax(0,1fr)] md:items-start md:gap-16">
          {/* --- 书：手机一行（小封面 + 文字），电脑一列（大封面在上） --- */}
          <div className="flex items-center gap-3.5 md:flex-col md:items-start md:gap-4">
            <div className="w-16 shrink-0 md:w-[280px]">
              <CoverImage src={coverUrl} alt="" sizeHint="(min-width: 768px) 280px, 64px" priority />
            </div>
            <div className="min-w-0">
              <p className="text-xs tracking-[0.08em] text-novel-fg-subtle uppercase md:hidden">{copy.nowReading}</p>
              <p className="mt-1 font-novel-serif text-[1.1875rem] leading-tight text-novel-fg md:mt-0 md:text-[1.375rem]" data-testid="code-mode-book-title">
                {title}
              </p>
              <p className="mt-1 text-[0.8125rem] text-novel-fg-muted md:text-sm">{copy.availableInApp}</p>
            </div>
          </div>

          {/* --- 说明 + 口令码 + 下载 --- */}
          <div className="flex flex-1 flex-col gap-5 md:flex-none md:gap-6">
            <h1 className="font-novel-serif text-[1.75rem] leading-[1.2] font-semibold text-novel-fg md:text-[2.5rem] md:leading-[1.15]">
              {copy.heading}
            </h1>
            <p className="hidden max-w-[35rem] text-[1.0625rem] leading-relaxed text-novel-fg-muted md:block" data-testid="code-mode-intro">
              {copy.intro}
            </p>

            {/* 口令码卡片：手机——标签在上，口令码与复制按钮同一行；电脑——口令码在左，按钮在右并垂直居中（设计稿两块画板） */}
            <section
              aria-label={copy.codeLabel}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3.5 rounded-novel-lg border border-novel-border bg-novel-bg-elevated p-[1.125rem] md:max-w-[35rem] md:gap-x-6 md:gap-y-1.5 md:px-7 md:py-6"
            >
              <p className="col-span-2 text-[0.8125rem] text-novel-fg-muted md:col-span-1 md:text-sm">{copy.codeLabel}</p>
              <p
                // 口令码一行显示：手机上字号随视口收缩（9.5vw，最大 2.5rem = 设计稿 40px），极长的码才允许在任意位置折行。
                className="min-w-0 font-mono text-[clamp(1.5rem,9.5vw,2.5rem)] leading-none font-bold tracking-[0.12em] text-novel-accent select-all [overflow-wrap:anywhere] md:text-5xl"
                data-testid="code-mode-code"
              >
                {code}
              </p>
              <div className="md:col-start-2 md:row-span-2 md:row-start-1 md:self-center">
                <CopyCodeButton code={code} label={copy.copyCode} copiedLabel={copy.copied} />
              </div>
            </section>

            {/* 三步说明：手机版（默认"三步版"）；电脑用上面那句话 */}
            <ol className="flex list-none flex-col gap-3.5 p-0 md:hidden" aria-label={copy.stepsLabel} data-testid="code-mode-steps">
              {copy.steps.map((step, index) => (
                <li key={step} className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-[1.625rem] shrink-0 items-center justify-center rounded-full bg-novel-accent text-sm font-bold text-novel-on-accent"
                  >
                    {index + 1}
                  </span>
                  <span className="pt-0.5 text-[0.9375rem] leading-normal text-novel-fg">{step}</span>
                </li>
              ))}
            </ol>

            <div className="mt-auto flex flex-col gap-2.5 md:mt-0 md:flex-row md:flex-wrap md:gap-3" data-testid="code-mode-store-links">
              {appStoreUrl ? (
                <ButtonLink href={appStoreUrl} variant="accent" size="lg" rel="noopener noreferrer" className="w-full md:w-auto">
                  <DownloadIcon />
                  {copy.appStore}
                </ButtonLink>
              ) : null}
              {googlePlayUrl ? (
                <ButtonLink href={googlePlayUrl} variant="outline" size="lg" rel="noopener noreferrer" className="w-full bg-novel-bg-elevated md:w-auto">
                  <DownloadIcon />
                  {copy.googlePlay}
                </ButtonLink>
              ) : null}
              {!hasStoreLink ? (
                <p className="text-[0.9375rem] text-novel-fg" data-testid="code-mode-search-fallback">
                  {copy.searchInStore}
                </p>
              ) : null}
            </div>

            <p className="text-center text-xs leading-normal text-novel-fg-subtle md:text-left md:text-[0.8125rem]">
              {copy.disclaimer(brandName)}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}
