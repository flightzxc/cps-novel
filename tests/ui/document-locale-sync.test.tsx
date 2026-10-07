import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { DocumentLocaleSync } from "@/features/public-ui/layout/DocumentLocaleSync";
import { SiteShell } from "@/features/public-ui/layout/SiteShell";
import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { getTextDirection } from "@/lib/site/text-direction";

/**
 * PN-02（2026-10-07 审计）：语言菜单用 `router.push` 软跳转，根布局不会重渲染，
 * `<html lang dir>` 停在上一个语种——从英语首页切到阿拉伯语后，页面内容是阿拉伯语，
 * 根属性却仍是 `lang="en" dir="ltr"`，与直接打开 `/ar` 不一致。
 *
 * `SiteShell` 挂载 `DocumentLocaleSync` 后，每次页面外壳（重新）渲染都按本页 locale
 * 写一次根属性。这里用真实 `documentElement` 断言，不 mock。
 */

const root = () => document.documentElement;
const attrs = () => ({ lang: root().lang, dir: root().dir });

function shell(locale: SiteLocale) {
  return (
    <SiteShell locale={locale}>
      <p>content</p>
    </SiteShell>
  );
}

let saved: { lang: string | null; dir: string | null };

beforeEach(() => {
  saved = { lang: root().getAttribute("lang"), dir: root().getAttribute("dir") };
  root().setAttribute("lang", "en");
  root().setAttribute("dir", "ltr");
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === null) root().removeAttribute(name);
    else root().setAttribute(name, value);
  }
});

describe("SiteShell 挂载 DocumentLocaleSync：<html lang dir> 跟随页面 locale（PN-02）", () => {
  it("根属性遗留 en/ltr 时渲染 ar 外壳 → ar/rtl；再渲染 en 外壳 → en/ltr", () => {
    expect(attrs()).toEqual({ lang: "en", dir: "ltr" });

    const view = render(shell("ar"));
    expect(attrs()).toEqual({ lang: "ar", dir: "rtl" });

    // 同一棵树换语种 = 软跳转：根布局不重渲染，只有外壳的 locale 变了
    view.rerender(shell("en"));
    expect(attrs()).toEqual({ lang: "en", dir: "ltr" });
  });

  it("en → ar → ja 连续软跳转：每一跳都与直接打开该语种页一致", () => {
    const view = render(shell("en"));
    expect(attrs()).toEqual({ lang: "en", dir: "ltr" });

    view.rerender(shell("ar"));
    expect(attrs()).toEqual({ lang: "ar", dir: "rtl" });

    view.rerender(shell("ja"));
    expect(attrs()).toEqual({ lang: "ja", dir: "ltr" });
  });

  it("外壳里确实挂了 DocumentLocaleSync：卸载其它一切、只看根属性是否被写", () => {
    // 这条是「摘掉 DocumentLocaleSync 就红」的直接承重用例：不依赖任何子组件的 DOM
    root().setAttribute("lang", "fr");
    root().setAttribute("dir", "ltr");

    render(shell("ar"));

    expect(root().getAttribute("lang")).toBe("ar");
    expect(root().getAttribute("dir")).toBe("rtl");
  });
});

describe("DocumentLocaleSync 本体", () => {
  it("每个已登记语种的 dir 都与站点唯一的方向判定 getTextDirection 一致（含从右到左的 ar）", () => {
    for (const locale of SITE_LOCALES) {
      root().setAttribute("lang", "x-stale");
      root().setAttribute("dir", locale === "ar" ? "ltr" : "rtl"); // 故意写成相反值
      const view = render(<DocumentLocaleSync locale={locale} />);

      expect(root().lang, locale).toBe(locale);
      expect(root().dir, locale).toBe(getTextDirection(locale));
      view.unmount();
    }
    expect(getTextDirection("ar")).toBe("rtl");
  });

  it("值已经相同时不写（不触发无谓的样式重算）", () => {
    root().setAttribute("lang", "ar");
    root().setAttribute("dir", "rtl");
    const observer = new MutationObserver(() => {});
    observer.observe(root(), { attributes: true });
    try {
      render(<DocumentLocaleSync locale="ar" />);
      expect(observer.takeRecords()).toHaveLength(0);
    } finally {
      observer.disconnect();
    }
  });

  it("只有一个属性不同时只写那一个", () => {
    root().setAttribute("lang", "ar");
    root().setAttribute("dir", "ltr");
    const observer = new MutationObserver(() => {});
    observer.observe(root(), { attributes: true });
    try {
      render(<DocumentLocaleSync locale="ar" />);
      const records = observer.takeRecords();
      expect(records.map((r) => r.attributeName)).toEqual(["dir"]);
      expect(attrs()).toEqual({ lang: "ar", dir: "rtl" });
    } finally {
      observer.disconnect();
    }
  });

  it("卸载不还原：下一页的外壳会写自己的值，还原只会在两页之间闪回上一个语种", () => {
    const view = render(<DocumentLocaleSync locale="ar" />);
    expect(attrs()).toEqual({ lang: "ar", dir: "rtl" });

    view.unmount();

    expect(attrs()).toEqual({ lang: "ar", dir: "rtl" });
  });

  it("不渲染任何 DOM", () => {
    const { container } = render(<DocumentLocaleSync locale="ar" />);
    expect(container.innerHTML).toBe("");
  });
});
