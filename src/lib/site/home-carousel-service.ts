import type { FeaturedEntry } from "@/features/public-ui/home/HomeScreen";
import type { SiteLocale } from "@/lib/locale/locale-canonical";

/**
 * Typed home-carousel contract aligned with `HomeScreen.featuredList`.
 *
 * Owner-final for this round: return an empty list. Do not import or query
 * the five `HomeCarousel*` tables. `heroImageUrl` has no DB column — do not
 * invent one. An empty list already skips FeaturedHero and FeaturedNovel.
 */
export type HomeCarouselItem = FeaturedEntry;

export async function getHomeCarouselItems(_locale: SiteLocale): Promise<HomeCarouselItem[]> {
  void _locale;
  return [];
}
