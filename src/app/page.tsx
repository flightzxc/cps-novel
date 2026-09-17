import type { Metadata } from "next";

import { buildHomeMetadata, HomeBody } from "@/app/_pages/home";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return buildHomeMetadata(PUBLIC_SITE_LOCALE);
}

export default async function HomePage() {
  return HomeBody({ locale: PUBLIC_SITE_LOCALE });
}
