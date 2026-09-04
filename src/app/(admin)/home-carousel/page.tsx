import { getHomeCarouselConfig } from "@/server/home-carousel";
import { prisma } from "../../api/admin/_lib/deps";
import { AdminShell } from "../_components/admin-shell";
import { sessionView } from "../_lib/page-guard";
import { requireContentPage } from "../novels/_lib/content-page-guard";
import { ContentCapabilityDenied } from "../novels/_components/content-states";
import { CarouselManager } from "./_components/carousel-manager";

export const dynamic = "force-dynamic";
export default async function HomeCarouselPage() {
  const { context, granted } = await requireContentPage("/home-carousel", "settings:manage");
  if (!granted) return <AdminShell session={sessionView(context)} title="首页轮播"><ContentCapabilityDenied capability="settings:manage" /></AdminShell>;
  const [config, slots, articles] = await Promise.all([
    getHomeCarouselConfig(prisma),
    prisma.homeCarouselManualSlot.findMany({ where: { locale: "en", deletedAt: null }, orderBy: { position: "asc" }, select: { id: true, position: true, articleId: true, enabled: true, article: { select: { title: true } } } }),
    prisma.article.findMany({ where: { locale: "en", status: "published", deletedAt: null, novel: { status: "published", deletedAt: null, coverUrl: { not: null } } }, orderBy: { updatedAt: "desc" }, take: 500, select: { id: true, title: true } }),
  ]);
  return <AdminShell session={sessionView(context)} title="首页轮播" description="维护人工位并通过 GenericTask 重算首页 serving 快照。"><CarouselManager config={config} slots={slots.map((slot) => ({ ...slot, title: slot.article.title }))} articles={articles} /></AdminShell>;
}
