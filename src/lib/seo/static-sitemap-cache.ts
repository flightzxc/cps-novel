import { promises as fs } from "node:fs";
import path from "node:path";

export const SITEMAP_STATIC_SOURCE_HEADER = "static";
export const SITEMAP_DYNAMIC_SOURCE_HEADER = "dynamic";

export function isProductionStaticSitemapRequired(): boolean {
  return process.env.NODE_ENV === "production";
}

export function getStaticSitemapRoot(): string {
  return process.env.SITEMAP_STATIC_DIR || path.join(process.cwd(), ".tmp/static-sitemaps");
}

export function getStaticSitemapCurrentDir(root = getStaticSitemapRoot()): string {
  return path.join(root, "current");
}

export function getSitemapSuccessHeaders(source: "static" | "dynamic" = "static") {
  return {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
    "X-Sitemap-Source": source,
  };
}

export function getSitemapUnavailableHeaders() {
  return {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Sitemap-Source": SITEMAP_STATIC_SOURCE_HEADER,
  };
}

export async function readStaticSitemapFile(relativePath: string): Promise<string | null> {
  const currentDir = getStaticSitemapCurrentDir();
  const normalizedPath = path.normalize(relativePath);
  if (
    normalizedPath.startsWith("..")
    || path.isAbsolute(normalizedPath)
    || normalizedPath === "."
  ) {
    return null;
  }

  try {
    return await fs.readFile(path.join(currentDir, normalizedPath), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
