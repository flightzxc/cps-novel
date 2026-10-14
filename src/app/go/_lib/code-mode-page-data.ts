/**
 * `/go/<站内码>/app` 中间页的取数与判定。
 *
 * 中间页只对**口令码模式剧场**的、**就绪**的推广链接成立：
 *   - 找不到 / 已软删除 / 不是口令码模式剧场（MoboReader 的 link 模式走 302，不该来到这里）→ not_found；
 *   - 口令码模式但不就绪（状态不是 fetched、口令码为空白、书的语种不在剧场白名单）→ not_found。
 * 判定一律走 `isPromoReady`（唯一权威），不在这里另写一份。
 *
 * 渠道真实口令码从这里流向页面——它是读者此刻要用的公开推广口令，只在这一个页面出现；
 * 其它任何视图模型 / 日志 / 审计都不带它。
 *
 * 🔴 口令码**只能**经数据库函数 `public.code_mode_upstream_code(站内码)` 取（SECURITY DEFINER，EXECUTE 只授给 web_app）：
 * web_app 在数据库层读不到 `promo_link.upstream_code`（列授权已撤），其它任何 web 路径都拿不到口令码。
 * 函数自己再按"口令码模式剧场 + 就绪"的规则校验一遍（未删除 ∧ fetched ∧ promoMode=code ∧ 口令码非空 ∧ 语种在白名单），
 * 不满足就返回 NULL——这里也就返回 null（页面 404）。上面的 `isPromoReady` 与函数同一套规则，两边必须一致；
 * 真实库用例（tests/integration/plotnovel/code-function-postgres.test.ts）逐项钉住。
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import { buildArticlePath } from "@/lib/slug/article-path";
import { asSiteLocale } from "@/lib/site/locale-label";
import {
  codeModeAppName,
  isCodeModeTheater,
  parseTheaterPromoConfig,
} from "@/server/publication/theater-promo-mode";
import { isPromoReady, PROMO_READINESS_SELECT } from "@/server/publication/visibility";

export type CodeModePageData = Readonly<{
  code: string;
  appName: string;
  appStoreUrl: string | null;
  googlePlayUrl: string | null;
  title: string;
  coverUrl?: string;
  backHref?: string;
}>;

type PageDb = Pick<PrismaClient, "promoLink" | "$queryRaw">;

export async function loadCodeModePageData(db: PageDb, publicRedirectCode: string): Promise<CodeModePageData | null> {
  const promoLink = await db.promoLink.findUnique({
    where: { publicRedirectCode },
    select: {
      ...PROMO_READINESS_SELECT,
      deletedAt: true,
      novel: { select: { locale: true, title: true, coverUrl: true } },
      // 回到书页的链接：这条推广链接绑定的、已发布的小说文章（取最近发布的一篇）。
      articles: {
        where: { status: "published", deletedAt: null, articleType: "novel_article" },
        select: { locale: true, slug: true, publicPageShortId: true },
        orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
        take: 1,
      },
    },
  });
  if (!promoLink || promoLink.deletedAt != null) return null;
  if (!isCodeModeTheater(promoLink.channelApp?.config)) return null;
  if (!isPromoReady(promoLink)) return null;

  // 口令码：只经数据库函数取（见文件头）。函数返回 NULL = 数据库层认为它不该放行 → 与未就绪同样处理。
  const rows = await db.$queryRaw<Array<{ code: string | null }>>(
    Prisma.sql`SELECT public.code_mode_upstream_code(${publicRedirectCode}) AS code`,
  );
  const code = rows[0]?.code?.trim();
  if (!code) return null;
  const theater = parseTheaterPromoConfig(promoLink.channelApp?.config);

  const article = promoLink.articles[0];
  const articleLocale = article ? asSiteLocale(article.locale) : null;
  const backHref = article && articleLocale
    ? buildArticlePath({ locale: articleLocale, slug: article.slug, shortId: article.publicPageShortId })
    : undefined;

  return {
    code,
    appName: codeModeAppName(theater),
    appStoreUrl: theater.appStoreUrl,
    googlePlayUrl: theater.googlePlayUrl,
    title: promoLink.novel?.title ?? "",
    coverUrl: promoLink.novel?.coverUrl ?? undefined,
    backHref,
  };
}
