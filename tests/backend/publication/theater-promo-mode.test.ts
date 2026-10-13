import { describe, expect, it } from "vitest";

import {
  DEFAULT_CODE_MODE_APP_NAME,
  codeModeAppName,
  isCodeModeBookReady,
  isCodeModeTheater,
  normalizeStoreUrl,
  parseTheaterPromoConfig,
} from "@/server/publication/theater-promo-mode";

describe("parseTheaterPromoConfig：认不出来就是 link 模式（维持改动前的行为）", () => {
  it.each([
    ["空对象（MoboReader 登记时的 config）", {}],
    ["null", null],
    ["数组", ["code"]],
    ["字符串", "code"],
    ["promoMode 缺省", { agencyIds: ["3366"] }],
    ["promoMode 拼错", { promoMode: "Code" }],
    ["promoMode 不是字符串", { promoMode: true }],
    ["promoMode 是 codes", { promoMode: "codes" }],
  ])("%s → link", (_name, config) => {
    expect(parseTheaterPromoConfig(config).promoMode).toBe("link");
    expect(isCodeModeTheater(config)).toBe(false);
  });

  it("只有精确的 \"code\" 才是口令码模式", () => {
    expect(parseTheaterPromoConfig({ promoMode: "code" }).promoMode).toBe("code");
    expect(isCodeModeTheater({ promoMode: "code" })).toBe(true);
  });

  it("agencyIds / codeModeLocales：只收非空字符串，去重去空白；超长与非字符串丢弃", () => {
    const parsed = parseTheaterPromoConfig({
      promoMode: "code",
      agencyIds: ["1351", " 1351 ", "", 5, null, "x".repeat(129), "3366"],
      codeModeLocales: ["en", "en", " "],
    });
    expect(parsed.agencyIds).toEqual(["1351", "3366"]);
    expect(parsed.codeModeLocales).toEqual(["en"]);
  });

  it("agencyIds 不是数组 → 空列表，而不是把字符串当单元素", () => {
    expect(parseTheaterPromoConfig({ agencyIds: "1351" }).agencyIds).toEqual([]);
  });
});

describe("normalizeStoreUrl：渲染前的最后一道防线", () => {
  it("只收 https 绝对地址", () => {
    expect(normalizeStoreUrl("https://apps.apple.com/app/plotnovel/id1")).toBe("https://apps.apple.com/app/plotnovel/id1");
  });

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://apps.apple.com/x",
    "//apps.apple.com/x",
    "/relative",
    "https://user:pass@apps.apple.com/x",
    "",
    "   ",
    "https://" + "a".repeat(2100),
  ])("拒绝 %s", (value) => {
    expect(normalizeStoreUrl(value)).toBeNull();
  });

  it("非字符串 → null", () => {
    expect(normalizeStoreUrl(undefined)).toBeNull();
    expect(normalizeStoreUrl(42)).toBeNull();
    expect(normalizeStoreUrl({ href: "https://x.test" })).toBeNull();
  });

  it("配置里写坏的链接解析成 null（页面据此不渲染按钮）", () => {
    const parsed = parseTheaterPromoConfig({ promoMode: "code", appStoreUrl: "javascript:alert(1)", googlePlayUrl: "https://play.google.com/store/apps/details?id=a.b" });
    expect(parsed.appStoreUrl).toBeNull();
    expect(parsed.googlePlayUrl).toBe("https://play.google.com/store/apps/details?id=a.b");
  });
});

describe("isCodeModeBookReady：口令码非空 ∧ 语种在白名单", () => {
  const config = { promoMode: "code", codeModeLocales: ["en"] };

  it("口令码非空 + 语种 en → 就绪", () => {
    expect(isCodeModeBookReady({ config, upstreamCode: "960031", novelLocale: "en" })).toBe(true);
  });

  it.each([null, undefined, "", "   ", "　 \t\n"])("口令码 %j（空白）→ 不就绪", (upstreamCode) => {
    expect(isCodeModeBookReady({ config, upstreamCode, novelLocale: "en" })).toBe(false);
  });

  it.each(["fr", "zh-Hant", "", null, undefined])("语种 %j 不在白名单 → 不就绪", (novelLocale) => {
    expect(isCodeModeBookReady({ config, upstreamCode: "960031", novelLocale })).toBe(false);
  });

  it("link 模式的剧场永远不适用口令码规则", () => {
    expect(isCodeModeBookReady({ config: { promoMode: "link", codeModeLocales: ["en"] }, upstreamCode: "960031", novelLocale: "en" })).toBe(false);
    expect(isCodeModeBookReady({ config: {}, upstreamCode: "960031", novelLocale: "en" })).toBe(false);
  });

  it("白名单为空 → 没有任何语种就绪", () => {
    expect(isCodeModeBookReady({ config: { promoMode: "code" }, upstreamCode: "960031", novelLocale: "en" })).toBe(false);
  });
});

describe("codeModeAppName", () => {
  it("没配就用默认名", () => {
    expect(codeModeAppName(parseTheaterPromoConfig({ promoMode: "code" }))).toBe(DEFAULT_CODE_MODE_APP_NAME);
    expect(codeModeAppName(parseTheaterPromoConfig({ promoMode: "code", appDisplayName: "PlotNovel Reader" }))).toBe("PlotNovel Reader");
  });
});
