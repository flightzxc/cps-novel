import { describe, expect, it } from "vitest";

import { chromeFromSiteSetting } from "@/lib/site/chrome";
import type { SiteSettingSnapshot } from "@/server/site-settings/service";

/**
 * R1-2 断点复现与回归覆盖。
 *
 * 断点：`chrome.ts` 从不读 `SiteSetting.siteName`，`chromeFromSiteSetting`
 * 的返回值里没有这个键——不是「配置没注入」，是没有注入口。这里直接测这一层
 * 映射，不依赖数据库。
 */

function fakeSettings(overrides: Partial<SiteSettingSnapshot> = {}): SiteSettingSnapshot {
  return {
    siteName: "CPS Novel",
    siteDescription: "",
    homeMetaTitle: "",
    homeMetaDescription: "",
    defaultOgImage: "",
    googleSearchConsoleVerification: "",
    footerCopyrightText: "",
    footerDisclaimerText: "",
    friendLinks: [],
    indexNowHost: "",
    indexNowKey: "",
    indexNowKeyLocation: "",
    ga4MeasurementId: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("chromeFromSiteSetting · siteName 接线", () => {
  it("把配置的品牌名透传进返回的 chrome", () => {
    const chrome = chromeFromSiteSetting(fakeSettings({ siteName: "海阅" }));
    expect(chrome.siteName).toBe("海阅");
  });

  it("DB 默认值 CPS Novel 原样透传，不做替换（接线后显示它是预期结果）", () => {
    const chrome = chromeFromSiteSetting(fakeSettings({ siteName: "CPS Novel" }));
    expect(chrome.siteName).toBe("CPS Novel");
  });
});
