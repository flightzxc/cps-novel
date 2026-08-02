import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { BRAND_PLACEHOLDER_TEXT } from "@/components/BrandMark";
import { SiteHeader } from "@/features/public-ui/layout/SiteHeader";
import { SiteShell } from "@/features/public-ui/layout/SiteShell";

const NAV = [
  { label: "首页", href: "/dev-preview/home", current: true },
  { label: "题材", href: "/dev-preview/collection" },
];

describe("页头", () => {
  it("渲染固定尺寸的 Logo 槽位与文字占位符", () => {
    render(<SiteHeader navItems={NAV} />);

    expect(screen.getByText(BRAND_PLACEHOLDER_TEXT)).toBeTruthy();

    const mark = document.querySelector('[data-brand-slot="mark"]');
    expect(mark).toBeTruthy();
    // 槽位尺寸固定：正式 Logo 到位后只替换资产，不重构页头
    expect(mark?.getAttribute("data-brand-slot-size")).toBe("32");
    expect((mark as HTMLElement).style.width).toBe("32px");
    expect((mark as HTMLElement).style.height).toBe("32px");
  });

  it("不放 emoji 当 Logo", () => {
    const { container } = render(<SiteHeader navItems={NAV} />);
    expect(container.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("活跃项用颜色 + 下划线双重编码，并标出 aria-current", () => {
    render(<SiteHeader navItems={NAV} />);

    const active = screen.getAllByRole("link", { name: "首页" })[0];
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(active.className).toContain("underline");
    expect(active.className).toContain("text-novel-primary");
  });

  it("语种入口在只有一个可发布语种时不出现", () => {
    render(<SiteHeader navItems={NAV} />);
    expect(screen.queryByRole("link", { name: "English" })).toBeNull();
  });

  it("有多个可发布语种时才渲染语种入口", () => {
    render(
      <SiteHeader
        navItems={NAV}
        localeNav={[{ label: "English", href: "/en" }]}
      />,
    );
    expect(screen.getAllByRole("link", { name: "English" }).length).toBeGreaterThan(0);
  });
});

describe("移动端导航", () => {
  it("默认收起，导航项不进入 Tab 序列", () => {
    render(<SiteHeader navItems={NAV} />);

    const toggle = screen.getByRole("button", { name: "打开菜单" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // 收起时整块不渲染，而不是靠 CSS 隐藏——隐藏元素仍可被键盘聚焦
    expect(screen.getAllByRole("link", { name: "题材" })).toHaveLength(1);
  });

  it("点击展开后渲染导航项并更新 aria-expanded", () => {
    render(<SiteHeader navItems={NAV} />);

    fireEvent.click(screen.getByRole("button", { name: "打开菜单" }));

    const toggle = screen.getByRole("button", { name: "关闭菜单" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("link", { name: "题材" })).toHaveLength(2);
  });

  it("Esc 关闭菜单并把焦点交还给触发按钮", () => {
    render(<SiteHeader navItems={NAV} />);

    fireEvent.click(screen.getByRole("button", { name: "打开菜单" }));
    fireEvent.keyDown(document, { key: "Escape" });

    const toggle = screen.getByRole("button", { name: "打开菜单" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("点击导航项后菜单收起", () => {
    render(<SiteHeader navItems={NAV} />);

    fireEvent.click(screen.getByRole("button", { name: "打开菜单" }));
    const mobileLink = screen.getAllByRole("link", { name: "题材" })[1];
    // 阻止默认跳转：jsdom 不实现导航，真跳会打出无关的 Not implemented 噪音
    mobileLink.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(mobileLink);

    expect(screen.getByRole("button", { name: "打开菜单" })).toBeTruthy();
  });
});

describe("页面壳", () => {
  it("第一个可聚焦元素是跳过导航的锚点", () => {
    const { container } = render(
      <SiteShell chrome={{ navItems: NAV }}>
        <p>正文</p>
      </SiteShell>,
    );

    const first = container.querySelector("a");
    expect(first?.textContent).toBe("跳到主要内容");
    expect(first?.getAttribute("href")).toBe("#main");
    expect(container.querySelector("#main")).toBeTruthy();
  });

  it("页脚链接由调用方注入，未注入时不渲染导航", () => {
    render(
      <SiteShell chrome={{}}>
        <p>正文</p>
      </SiteShell>,
    );

    expect(screen.queryByRole("navigation", { name: "页脚导航" })).toBeNull();
  });

  it("页脚不含应用下载或用户体系入口", () => {
    const { container } = render(
      <SiteShell chrome={{ footerLinks: [{ label: "关于本站", href: "/about" }] }}>
        <p>正文</p>
      </SiteShell>,
    );

    const footer = container.querySelector("footer");
    const text = within(footer as HTMLElement).getByRole("navigation").textContent ?? "";
    expect(text).not.toMatch(/App Store|Google Play|下载|登录|注册/);
  });
});