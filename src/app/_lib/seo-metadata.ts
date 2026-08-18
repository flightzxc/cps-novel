import type { Metadata } from "next";

import type { SeoOutput } from "@/lib/seo/seo-meta-generator";

/** Map the SEO factory onto Next metadata. Innermost `robots` overrides the root noindex. */
export function toNextMetadata(seo: SeoOutput): Metadata {
  return {
    title: seo.title,
    description: seo.description,
    alternates: seo.alternates,
    openGraph: seo.openGraph,
    twitter: seo.twitter,
    robots: seo.robots ?? { index: true, follow: true },
  };
}

export function noIndexMetadata(title: string): Metadata {
  return {
    title,
    robots: { index: false, follow: false },
  };
}
