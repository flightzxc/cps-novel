import type { MetadataRoute } from "next";
import { connection } from "next/server";

import { getSiteUrl } from "@/lib/seo/site-url";

const PRIVATE_ROUTE_PREFIXES = [
  "/api/admin",
  "/channel-accounts",
  "/novels",
  "/tags",
  "/tasks",
  "/settings",
  "/dev-preview",
  "/go",
  // PR-C1: the admin login / 2FA challenge / 2FA setup surface
  // (`(admin-auth)` route group). These pages are outside `(admin)` and
  // `ADMIN_PAGE_ROOTS` by design (see `(admin-auth)/_lib/auth-session.ts`),
  // so they are not covered by any of the prefixes above and need their own
  // entries. Per-page `robots: { index: false, follow: false }` metadata
  // already keeps them out of the index; this additionally keeps crawlers
  // from spending budget on them.
  "/login",
  "/two-factor",
] as const;

export function buildRobots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: [...PRIVATE_ROUTE_PREFIXES] }],
    sitemap: `${getSiteUrl()}/sitemap.xml`,
  };
}

export default async function robots(): Promise<MetadataRoute.Robots> {
  // SITE_URL is a runtime deployment contract. This dynamic boundary prevents
  // Next from evaluating the strict origin check while building the image.
  await connection();
  return buildRobots();
}
