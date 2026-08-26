import { describe, expect, it } from "vitest";

import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { getHomeName } from "@/lib/seo/breadcrumb-i18n";

describe("getHomeName", () => {
  it("returns the English Home label by default", () => {
    expect(getHomeName("en")).toBe("Home");
    expect(getHomeName(null)).toBe("Home");
    expect(getHomeName(undefined)).toBe("Home");
  });

  it("keeps extra locale entries even though V1 only calls en", () => {
    expect(getHomeName("ja")).toBe("ホーム");
    expect(getHomeName("pt-BR")).toBe("Início");
  });

  /**
   * P0-S14：HOME_LABELS 的类型从 `Record<string, string>` 改成
   * `Record<SiteLocale, string>` 之后，这张表在编译期就必须覆盖全部 15 个
   * 站点 locale——这条用例把编译期的穷尽性桥接成一条运行时回归：任何一个
   * `SiteLocale` 传进来都必须拿到非空字符串，一个不漏。
   */
  it("🔴 全部 15 个站点 locale 都有非空 Home 标签——表与 SITE_LOCALES 同步", () => {
    for (const locale of SITE_LOCALES) {
      const label = getHomeName(locale);
      expect(label, `${locale} 缺少 Home 标签`).toEqual(expect.any(String));
      expect(label.length, `${locale} 的 Home 标签是空串`).toBeGreaterThan(0);
    }
  });

  /**
   * P0-S14：这条断言取代了旧版「falls back to Home for unknown locales」。
   * 旧行为（`?? HOME_LABELS["en"]`）会让未注册 locale 的面包屑静默显示英文，
   * 经 JSON-LD BreadcrumbList 进公开 DOM——这正是 CPS v6.0.4 事故的形状。
   * 现在缺失必须抛，不得吞掉。
   */
  it("🔴 未注册的 locale 必须抛出，不再静默落回英文", () => {
    expect(() => getHomeName("xx")).toThrow(/no breadcrumb "Home" label registered/);
    expect(() => getHomeName("zh-TW")).toThrow(/zh-TW/);
    expect(() => getHomeName("EN")).toThrow(/EN/);
  });
});
