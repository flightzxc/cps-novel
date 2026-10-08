import "./setup-cleanup";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import {
  SITE_LOCALES,
  SITE_LOCALE_NATIVE_NAMES,
  type SiteLocale,
} from "@/lib/locale/locale-canonical";
import { loadMessages } from "@/lib/locale/messages";
import { MessagesProvider } from "@/lib/locale/messages/MessagesProvider";

/**
 * PN-09（Owner 2026-10-08：没有书时连入口也隐藏）——语言菜单一侧。
 *
 * 菜单的数据来源是 `activeLocales` 属性（页面层 `loadActiveLocales()` ← `getActiveLocales()`
 * 传下来的"有书的语种"集合）。菜单条目 = 该集合 ∪ {当前语种} ∪ {en}：
 *  - 空语种（不在集合里）一概不列；
 *  - 唯一的例外是读者当前正在看的语种——直接打开 `/cs` 这样的空语种时，菜单里仍要有它
 *    （并标 `aria-current`），免得触发按钮上的语种名在菜单里找不到；
 *  - 全站只有英文有书（集合只剩 `["en"]`）而读者恰好在空语种页面上时，菜单依然渲染
 *    （English + 当前语种），读者有路回到英文。
 *
 * 菜单本身不做"有没有书"的判断（不另查一份）——这里用混合场景证明它只信集合。
 *
 * 反向自检：把 `LocaleSwitcher.tsx` 里 `menuItems` 的过滤去掉（恒列 `SITE_LOCALES` 全部 15 个）
 * → "只列非空语种"两条红；把"∪ 当前语种"去掉 → "当前语种是空语种仍显示"红；
 * 把 `LocaleSwitcher` 里的 `useOptionalLocale` 判定去掉（恢复 `activeLocales.length <= 1`）
 * → "全站只有英文有书"红。
 */
const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: routerPush }),
}));

const { LocaleSwitcher } = await import("@/features/public-ui/layout/LocaleSwitcher");

/** 混合场景：en/ko/ru 有书，其余 12 个登记语种（含 cs、de）都是空语种。 */
const ACTIVE_MIXED: readonly SiteLocale[] = ["en", "ko", "ru"];

function renderSwitcher(locale: SiteLocale, activeLocales: readonly SiteLocale[]) {
  return render(
    <MessagesProvider locale={locale} messages={loadMessages(locale)}>
      <LocaleSwitcher activeLocales={activeLocales} />
    </MessagesProvider>,
  );
}

function openMenuItems(): HTMLElement[] {
  fireEvent.click(screen.getByRole("button", { name: /Language|언어|Язык|Jazyk/ }));
  return within(screen.getByRole("menu")).getAllByRole("menuitem");
}

function names(items: HTMLElement[]): string[] {
  return items.map((item) => item.textContent ?? "");
}

describe("LocaleSwitcher：只列非空语种", () => {
  it("在英文页面上：恰好列出 en、ko、ru（按登记顺序），任何空语种都不出现", () => {
    renderSwitcher("en", ACTIVE_MIXED);
    const listed = names(openMenuItems());
    const expected = SITE_LOCALES.filter((locale) => ACTIVE_MIXED.includes(locale)).map(
      (locale) => SITE_LOCALE_NATIVE_NAMES[locale],
    );
    expect(listed).toEqual(expected);
    expect(listed).toEqual(["English", "한국어", "Русский"]);
    for (const locale of SITE_LOCALES.filter((candidate) => !ACTIVE_MIXED.includes(candidate))) {
      expect(listed, locale).not.toContain(SITE_LOCALE_NATIVE_NAMES[locale]);
    }
  });

  it("在非空语种（ru）页面上：同样只列活跃语种，当前语种 ru 标 aria-current", () => {
    renderSwitcher("ru", ACTIVE_MIXED);
    const items = openMenuItems();
    expect(names(items)).toEqual(["English", "한국어", "Русский"]);
    const current = items.filter((item) => item.getAttribute("aria-current") === "true");
    expect(names(current)).toEqual(["Русский"]);
    expect(names(items)).not.toContain("Čeština");
    expect(names(items)).not.toContain("Deutsch");
  });
});

describe("LocaleSwitcher：当前语种是空语种", () => {
  it("直接打开 /cs（cs 没有书）：菜单仍有 Čeština 并标 aria-current，但不列其它空语种", () => {
    renderSwitcher("cs", ACTIVE_MIXED);
    const items = openMenuItems();
    const listed = names(items);
    // 登记顺序：en … ko … cs … ru
    expect(listed).toEqual(["English", "한국어", "Čeština", "Русский"]);
    expect(names(items.filter((item) => item.getAttribute("aria-current") === "true"))).toEqual(["Čeština"]);
    // 其它 11 个空语种（de、ja、es、fr…）一概不列。
    const otherEmpties = SITE_LOCALES.filter((locale) => locale !== "cs" && !ACTIVE_MIXED.includes(locale));
    expect(otherEmpties).toHaveLength(11);
    for (const locale of otherEmpties) {
      expect(listed, locale).not.toContain(SITE_LOCALE_NATIVE_NAMES[locale]);
    }
  });

  it("触发按钮上显示的就是当前（空）语种的自称，与菜单里的当前条目一致", () => {
    renderSwitcher("cs", ACTIVE_MIXED);
    const trigger = screen.getAllByRole("button")[0]!;
    expect(trigger.textContent).toContain("Čeština");
  });

  it("全站只有英文有书（activeLocales = [en]）而读者在 /cs 上：菜单仍渲染 English + Čeština", () => {
    renderSwitcher("cs", ["en"]);
    const items = openMenuItems();
    expect(names(items)).toEqual(["English", "Čeština"]);
    expect(names(items.filter((item) => item.getAttribute("aria-current") === "true"))).toEqual(["Čeština"]);
  });

  it("全站只有英文有书而读者在英文页面上：不渲染任何 DOM（没有可切换的语种）", () => {
    const { container } = renderSwitcher("en", ["en"]);
    expect(container.innerHTML).toBe("");
  });

  it("没有传 activeLocales（缺省 []）：不渲染任何 DOM，即便当前语种是 cs", () => {
    const { container } = render(
      <MessagesProvider locale="cs" messages={loadMessages("cs")}>
        <LocaleSwitcher />
      </MessagesProvider>,
    );
    expect(container.innerHTML).toBe("");
  });
});
