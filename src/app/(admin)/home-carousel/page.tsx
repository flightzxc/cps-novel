import {
  getHomeCarouselConfig,
  listHomeCarouselChangeLog,
  listHomeCarouselServing,
  listLatestHomeCarouselCandidates,
} from "@/server/home-carousel";
import { SITE_LOCALES, SITE_LOCALE_LABELS, type SiteLocale } from "@/lib/locale/locale-canonical";
import { prisma } from "../../api/admin/_lib/deps";
import { AdminShell } from "../_components/admin-shell";
import { sessionView } from "../_lib/page-guard";
import { requireContentPage } from "../novels/_lib/content-page-guard";
import { ContentCapabilityDenied } from "../novels/_components/content-states";
import { CarouselManager } from "./_components/carousel-manager";

export const dynamic = "force-dynamic";

type SearchParams = { locale?: string };

/**
 * L10N P5 (矩阵 #13, CPS v7.7 轮播定稿 "locale 白名单 fail-closed" 参照):
 * this page/`CarouselManager` used to hardcode `"en"` at 5 call sites here
 * plus 4 more in `carousel-manager.tsx` (both the read side —人工位/候选/
 * serving/变更日志四块视图 — and the write side, every mutation action
 * call). Adds a `?locale=` query-param selector, options = `SITE_LOCALES`
 * (静态层, matching this admin surface's own existing convention — see
 * `template-manager.tsx`'s locale `<select>`), default `en`. An unregistered
 * or missing value fails closed to `en` rather than passing an arbitrary
 * string through to the Prisma `locale` filters below.
 */
function resolveRequestedLocale(raw: string | undefined): SiteLocale {
  return raw && (SITE_LOCALES as readonly string[]).includes(raw) ? (raw as SiteLocale) : "en";
}

export default async function HomeCarouselPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const locale = resolveRequestedLocale(params.locale);
  const { context, granted } = await requireContentPage("/home-carousel", "settings:manage");
  if (!granted) return <AdminShell session={sessionView(context)} title="首页轮播"><ContentCapabilityDenied capability="settings:manage" /></AdminShell>;
  const config = await getHomeCarouselConfig(prisma);
  const [slots, articles, latest, serving, changeLog] = await Promise.all([
    prisma.homeCarouselManualSlot.findMany({ where: { locale, deletedAt: null }, orderBy: { position: "asc" }, select: { id: true, position: true, articleId: true, enabled: true, article: { select: { title: true } } } }),
    prisma.article.findMany({ where: { locale, status: "published", deletedAt: null, novel: { status: "published", deletedAt: null, coverUrl: { not: null } } }, orderBy: { updatedAt: "desc" }, take: 500, select: { id: true, title: true } }),
    listLatestHomeCarouselCandidates(prisma, locale),
    listHomeCarouselServing(prisma, locale),
    listHomeCarouselChangeLog(prisma, locale),
  ]);
  return (
    <AdminShell session={sessionView(context)} title="首页轮播" description="维护人工位并通过 GenericTask 重算首页 serving 快照。">
      <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <form method="GET" className="flex flex-wrap items-end gap-3" role="search">
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">语种</span>
            <select
              name="locale"
              defaultValue={locale}
              aria-label="语种"
              className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
            >
              {SITE_LOCALES.map((option) => (
                <option key={option} value={option}>
                  {SITE_LOCALE_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200">
            切换语种
          </button>
        </form>
      </div>
      <CarouselManager
        locale={locale}
        config={config}
        slots={slots.map((slot) => ({ ...slot, title: slot.article.title }))}
        articles={articles}
        latestBatch={latest.batch}
        candidates={latest.candidates.map((row) => ({ id: row.id, rank: row.rank, source: row.source, title: row.novel.title }))}
        serving={serving.map((row) => ({ id: row.id, position: row.position, source: row.source, title: row.novel.title }))}
        changeLog={changeLog.map((row) => ({ id: String(row.id), action: row.action, actorType: row.actorType, actorId: row.actorId, createdAt: row.createdAt.toISOString() }))}
      />
    </AdminShell>
  );
}
