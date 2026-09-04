import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeGa4MeasurementId } from "@/lib/seo/ga4-measurement-id";
import { chromeFromSiteSetting } from "@/lib/site/chrome";

const setting = {
  siteName: "Haiyue", siteDescription: "desc", homeMetaTitle: "Home title", homeMetaDescription: "Home desc",
  defaultOgImage: "/og.jpg", googleSearchConsoleVerification: "google-code", footerCopyrightText: "© Haiyue",
  footerDisclaimerText: "Disclaimer", friendLinks: [{ name: "Partner", url: "https://partner.example", nofollow: true }],
  indexNowHost: "", indexNowKey: "", indexNowKeyLocation: "", ga4MeasurementId: "G-ABC123", updatedAt: new Date(),
};

describe("SiteSetting public consumers", () => {
  it("uses the exact CPS GA4 normalizer", () => {
    expect(normalizeGa4MeasurementId(" G-ABC123 ")).toBe("G-ABC123");
    expect(normalizeGa4MeasurementId("UA-123")).toBeNull();
  });

  it("projects friend links and copyright/disclaimer into footer chrome", () => {
    const chrome = chromeFromSiteSetting(setting);
    expect(chrome.footerLinks).toEqual([expect.objectContaining({ label: "Partner", href: "https://partner.example", external: true, nofollow: true })]);
    expect(chrome.footerNote).toContain("© Haiyue");
    expect(chrome.footerNote).toContain("Disclaimer");
  });

  it("wires GSC and GA4 into the root head without a second settings source", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/app/layout.tsx"), "utf8");
    expect(source).toContain('name="google-site-verification"');
    expect(source).toContain("<GoogleAnalytics gaId={settings.ga4MeasurementId}");
    expect(source).toContain("getSiteSetting(prisma)");
  });
});
