import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { prisma } from "@/app/_lib/public-deps";
import { loadCodeModePageData } from "@/app/go/_lib/code-mode-page-data";
import { CodeModeInterstitial } from "@/features/public-ui/go/CodeModeInterstitial";
import { codeModeCopy, DEFAULT_CODE_MODE_APP_NAME } from "@/lib/locale/code-mode-copy";
import { resolveSiteBrandName } from "@/lib/seo/site-brand";
import { getSiteSetting } from "@/server/site-settings/service";

/**
 * 口令码模式中间页（v0.6.0）：`/go/<站内码>/app`。
 *
 * `/go/<站内码>` 对口令码模式剧场（PlotNovel）的推广链接 302 到这里；link 模式（MoboReader）的 302 跳转一字不变。
 *
 * 约束（Owner 拍板 + 开发单）：
 *   - 在 `/go/` 之下（`robots.txt` 已 Disallow `/go`）；
 *   - `noindex, nofollow`：元数据显式写，不依赖根布局的默认；
 *   - 不缓存：动态渲染（`force-dynamic`），Next 对动态页统一发 `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`；
 *   - 站内码找不到 / 已删除 / 不是口令码模式 / 不就绪 → 404。"不就绪"由本页用唯一权威 `isPromoReady` 判定
 *     （状态是 fetched、口令码去空白后非空、书的语种在剧场白名单里）。路由 `/go/<站内码>` 不读口令码，所以只能放行
 *     "口令码模式 + 状态 fetched"：口令码为空白或语种不在白名单的推广，路由照样 302 到这里，由本页 404——这是预期行为，
 *     不是漏判（用例：`tests/backend/public/go-redirect.test.ts` 钉路由只看状态，`code-mode-page.test.ts` 钉本页的细判定）；
 *   - 不记录点击（Owner 拍板第 6 项：点击记录不做）。
 *
 * `<title>` 刻意写成通用的一句，不含书名、更不含口令码。
 */
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return {
    title: codeModeCopy(DEFAULT_CODE_MODE_APP_NAME).interstitial.pageTitle,
    robots: { index: false, follow: false, nocache: true },
  };
}

export default async function CodeModeInterstitialPage({ params }: { params: Promise<{ code: string }> }) {
  const raw = (await params).code;
  let code: string;
  try {
    code = decodeURIComponent(raw ?? "").trim();
  } catch {
    notFound();
  }
  // 与 `/go/[code]/route.ts` 同样宽松：只按站内码精确查库，不另设格式闸（查不到就是 404）；长度上限只为挡掉畸形输入。
  if (!code || code.length > 64) notFound();

  const data = await loadCodeModePageData(prisma, code);
  if (!data) notFound();

  const settings = await getSiteSetting(prisma);
  return (
    <CodeModeInterstitial
      brandName={resolveSiteBrandName(settings.siteName)}
      appName={data.appName}
      title={data.title}
      coverUrl={data.coverUrl}
      code={data.code}
      backHref={data.backHref}
      appStoreUrl={data.appStoreUrl}
      googlePlayUrl={data.googlePlayUrl}
    />
  );
}
