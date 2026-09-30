import { promises as fs } from "node:fs";
import path from "node:path";

import { extractIndexedSitemapFileNames } from "@/lib/seo/sitemap";

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

/**
 * 当前发布目录的总索引里列出的全部分片文件名；总索引本身读不到（还没有任何发布）返回 null。
 *
 * 运营 V2（Owner 2026-09-30）：`/sitemap/[fileName]` 用它区分"格式合法但当前发布里没有的文件"
 * 的两种原因——总索引读不到 = 服务尚不可用（503）；总索引读得到却没列这个文件 = 这个语种 /
 * 这一类分片就是不存在（没有公开内容的语种、关闭的博客家族、超出实际分片数的序号），应当 404，
 * 而不是让爬虫以为"暂时不可用"反复重试。
 */
export async function readStaticSitemapIndexedFileNames(): Promise<ReadonlySet<string> | null> {
  const indexXml = await readStaticSitemapFile("sitemap.xml");
  return indexXml === null ? null : new Set(extractIndexedSitemapFileNames(indexXml));
}
