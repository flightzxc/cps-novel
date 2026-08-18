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
