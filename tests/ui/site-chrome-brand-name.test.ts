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
   * 品牌统一为 PulseNovel 之后，真实环境里这一行可能是任意值：全新环境是
   * `CPS Novel`（v0.2.0 foundation 迁移的 seed 继承了当时的列 DEFAULT），
   * 配置过的环境是运营在后台填的值。所以两个都测：拿到什么就显示什么，代码里
   * 不许出现「看到旧品牌名就换成新的」这类特判——那会让「站点名是运营配置项」
   * 这条架构事实失效。
   *
   * 🔴 不要为了让新环境直接拿到 PulseNovel 去改列 DEFAULT：2026-09-20 空库实测
   * 证明无效（单例行先于后续迁移定型），相关迁移已回退，依据见
   * `docs/governance/database-governance.md` §12 与
   * `docs/governance/ENVIRONMENT_PROVISIONING_CHECKLIST.md`。
   */
  it("配置值原样透传，不做品牌替换——新旧默认值一视同仁", () => {
    for (const name of ["CPS Novel", "PulseNovel"]) {
      const chrome = chromeFromSiteSetting(fakeSettings({ siteName: name }), "en");
      expect(chrome.siteName).toBe(name);
    }
  });
});
