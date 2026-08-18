import type { MetadataRoute } from "next";

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

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: [...PRIVATE_ROUTE_PREFIXES] }],
    sitemap: `${getSiteUrl()}/sitemap.xml`,
  };
}
