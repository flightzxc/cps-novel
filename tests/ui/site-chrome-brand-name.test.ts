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
  // WO-1 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §6.3): `locale`
  // became a required second positional argument — mechanically updated
  // below, `"en"` in both cases (this test is about `siteName` passthrough,
  // unrelated to locale text).
  it("把配置的品牌名透传进返回的 chrome", () => {
    const chrome = chromeFromSiteSetting(fakeSettings({ siteName: "海阅" }), "en");
    expect(chrome.siteName).toBe("海阅");
  });

  /**
   * 承重点是「配置值原样透传、代码不做任何替换」，不是某个具体字符串。
   *
   * 2026-09-19 品牌接入把**新环境**的列默认值从 `CPS Novel` 改成了 `PulseNovel`
   * （迁移 `20260919120000_site_setting_brand_default_pulsenovel`），但已有环境
   * 那一行不受默认值影响，仍可能是 `CPS Novel` 或运营改过的任意值。所以两个都
   * 测：拿到什么就显示什么，代码里不许出现「看到旧品牌名就换成新的」这类特判。
   */
  it("配置值原样透传，不做品牌替换——新旧默认值一视同仁", () => {
    for (const name of ["CPS Novel", "PulseNovel"]) {
      const chrome = chromeFromSiteSetting(fakeSettings({ siteName: name }), "en");
      expect(chrome.siteName).toBe(name);
    }
  });
});
