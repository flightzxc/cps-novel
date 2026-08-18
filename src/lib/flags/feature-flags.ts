export const NOVEL_CATALOG_SYNC_FEATURE_FLAG = "FEATURE_NOVEL_CATALOG_SYNC";
export const NOVEL_CATALOG_SYNC_ALLOW_WRITE_FLAG = "NOVEL_CATALOG_SYNC_ALLOW_WRITE";
export const SITEMAP_AUTO_REFRESH_FEATURE_FLAG = "FEATURE_SITEMAP_AUTO_REFRESH";
export const SITEMAP_AUTO_REFRESH_ALLOW_WRITE_FLAG = "SITEMAP_AUTO_REFRESH_ALLOW_WRITE";

export function isNovelCatalogSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[NOVEL_CATALOG_SYNC_FEATURE_FLAG] === "true";
}

export function isNovelCatalogSyncWriteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[NOVEL_CATALOG_SYNC_ALLOW_WRITE_FLAG] === "true";
}

export function isSitemapAutoRefreshEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SITEMAP_AUTO_REFRESH_FEATURE_FLAG] === "true";
}

export function isSitemapAutoRefreshWriteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SITEMAP_AUTO_REFRESH_ALLOW_WRITE_FLAG] === "true";
}
