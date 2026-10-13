import "./setup-cleanup";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import { StickyCTA } from "@/features/public-ui/layout/StickyCTA";
import { NovelDetailScreen } from "@/features/public-ui/novel/NovelDetailScreen";
import { MOCK_CHAPTER, MOCK_NOVEL_DETAIL } from "@/features/public-ui/fixtures/mock-content";
import type { ChapterView, NovelDetailView } from "@/features/public-ui/types";

/**
 * v0.6.0 F.2：书页、章节页、底部浮条的"去阅读"入口按剧场模式切换文案。
 *   link 模式（缺省）：完全不变（"Continue reading"，没有小字）；
 *   口令码模式：按钮 "Read on PlotNovel App" + 按钮下一行 "Free app · your book code is on the next page"。
 *
 * 🔴 F.3：渠道真实口令码只出现在中间页——这些页面的 HTML 里一个字也不能有。夹具里的口令码用一个不会和别的文本撞车的串。
 */
const SECRET_CODE = "ZX960031QQ";
const HINT = "Free app · your book code is on the next page";
const codeNovel: NovelDetailView = { ...MOCK_NOVEL_DETAIL, readOnUpstreamHref: "/go/abc123xy9z", readOnUpstreamMode: "code", readOnUpstreamAppName: "PlotNovel" };
const codeChapter: ChapterView = { ...MOCK_CHAPTER, readOnUpstreamHref: "/go/abc123xy9z", readOnUpstreamMode: "code", readOnUpstreamAppName: "PlotNovel" };

describe("书页主按钮", () => {
  it("口令码模式：按钮写 Read on PlotNovel App，下面有一行小字，指向同一个 /go/<站内码>", () => {
    render(<NovelDetailScreen locale="en" novel={codeNovel} />);
    const cta = screen.getByTestId("code-mode-read-cta");
    const link = within(cta).getByRole("link", { name: /Read on PlotNovel App/ });
    expect(link.getAttribute("href")).toBe("/go/abc123xy9z");
    expect(link.getAttribute("rel")).toBe("nofollow sponsored");
    expect(within(cta).getByText(HINT)).toBeTruthy();
  });

  it("link 模式：完全不变——按钮仍是 Continue reading，页面里没有口令码模式的任何文案", () => {
    const { container } = render(<NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL} />);
    expect(screen.queryByTestId("code-mode-read-cta")).toBeNull();
    expect(screen.getAllByRole("link", { name: "Continue reading" }).length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain(HINT);
    expect(container.textContent).not.toContain("Read on PlotNovel App");
  });

  it("没有站内跳转码就没有入口（口令码模式同样）", () => {
    render(<NovelDetailScreen locale="en" novel={{ ...codeNovel, readOnUpstreamHref: undefined }} />);
    expect(screen.queryByTestId("code-mode-read-cta")).toBeNull();
    expect(screen.queryByRole("link", { name: /Read on PlotNovel App/ })).toBeNull();
  });

  it("App 名取自剧场配置（视图模型里的 readOnUpstreamAppName）", () => {
    render(<NovelDetailScreen locale="en" novel={{ ...codeNovel, readOnUpstreamAppName: "ReadNow" }} />);
    // 主按钮 + 底部浮条，两处都用剧场配置的 App 名
    expect(screen.getAllByRole("link", { name: /Read on ReadNow App/ })).toHaveLength(2);
    expect(screen.queryByRole("link", { name: /Read on PlotNovel App/ })).toBeNull();
  });
});

describe("底部浮条", () => {
  it("口令码模式：accent 按钮写 Read on PlotNovel App，仍跳 /go/<站内码>", () => {
    render(<StickyCTA locale="en" href="/go/abc123xy9z" mode="code" appName="PlotNovel" />);
    const link = screen.getByRole("link", { name: "Read on PlotNovel App" });
    expect(link.getAttribute("href")).toBe("/go/abc123xy9z");
    expect(link.getAttribute("rel")).toBe("nofollow sponsored");
    expect(screen.getByTestId("sticky-cta-spacer")).toBeTruthy();
  });

  it("link 模式（缺省）：文案与改动前一致", () => {
    render(<StickyCTA locale="en" href="/go/abc123xy9z" />);
    expect(screen.getByRole("link", { name: "Continue reading" }).getAttribute("href")).toBe("/go/abc123xy9z");
    expect(screen.queryByText(/Read on/)).toBeNull();
  });

  it("没有链接时整块不渲染（与模式无关）", () => {
    const { container } = render(<StickyCTA locale="en" href={undefined} mode="code" />);
    expect(container.firstChild).toBeNull();
  });
});

describe("章节页", () => {
  it("口令码模式：章末按钮与底部浮条都写 Read on PlotNovel App，章末按钮下有小字", () => {
    render(<ChapterScreen locale="en" chapter={codeChapter} />);
    expect(screen.getAllByRole("link", { name: /Read on PlotNovel App/ }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(HINT)).toBeTruthy();
  });

  it("link 模式：章末按钮仍是原文案，没有小字", () => {
    render(<ChapterScreen locale="en" chapter={{ ...MOCK_CHAPTER, readOnUpstreamHref: "/go/abc123xy9z" }} />);
    expect(screen.queryByText(HINT)).toBeNull();
    expect(screen.queryByRole("link", { name: /Read on PlotNovel App/ })).toBeNull();
  });
});

describe("🔴 渠道真实口令码不进书页 / 章节页的 HTML（口令码模式同样）", () => {
  it("视图模型里没有口令码字段；整页 HTML 里没有它", () => {
    // 夹具故意把口令码塞进"不该有的地方"之外的任何字段都没有——视图模型类型里根本没有这个字段，
    // 这里再用整页 HTML 钉一遍：即使将来有人把它错放进某个文本字段之外的地方，也只有"文本里出现"才算泄漏，
    // 而页面渲染的所有文本都来自视图模型。
    const detail = render(<NovelDetailScreen locale="en" novel={{ ...codeNovel, description: "A coastal town." }} />);
    expect(detail.container.innerHTML).not.toContain(SECRET_CODE);
    expect(JSON.stringify(codeNovel)).not.toContain(SECRET_CODE);
    detail.unmount();
    const chapter = render(<ChapterScreen locale="en" chapter={codeChapter} />);
    expect(chapter.container.innerHTML).not.toContain(SECRET_CODE);
    expect(JSON.stringify(codeChapter)).not.toContain(SECRET_CODE);
    expect(Object.keys(codeNovel)).not.toContain("upstreamCode");
    expect(Object.keys(codeChapter)).not.toContain("upstreamCode");
  });
});
