export class SiteUrlConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteUrlConfigurationError";
  }
}

export function getSiteUrl(
  env: Readonly<{ SITE_URL?: string }> = { SITE_URL: process.env.SITE_URL },
): string {
  const raw = env.SITE_URL?.trim();
  if (!raw) {
    throw new SiteUrlConfigurationError("SITE_URL must be configured");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SiteUrlConfigurationError("SITE_URL must be an absolute HTTP(S) origin");
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new SiteUrlConfigurationError("SITE_URL must be an absolute HTTP(S) origin without credentials, path, query, or fragment");
  }

  return parsed.origin;
}

export function toAbsoluteUrl(pathOrUrl: string): string;
export function toAbsoluteUrl(pathOrUrl: string | null): string | undefined;
export function toAbsoluteUrl(pathOrUrl: string | undefined): string | undefined;
export function toAbsoluteUrl(pathOrUrl: string | null | undefined): string | undefined;
export function toAbsoluteUrl(pathOrUrl: string | null | undefined): string | undefined {
  if (!pathOrUrl) return undefined;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${getSiteUrl()}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
}
