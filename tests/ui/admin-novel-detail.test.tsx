import "./setup-cleanup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { projectAdminChapterListItem, projectAdminNovelDetail } from "@/contracts";
import { LABEL_KINDS } from "@/domain/database-statuses";
import { ChaptersTable } from "@/app/(admin)/novels/_components/chapters-table";
import {
  NovelIdentityPanel,
  NovelLabelsPanel,
  NovelPreviewPanel,
  NovelSourcesPanel,
  NovelSyncPanel,
} from "@/app/(admin)/novels/_components/novel-detail-panels";

import {
  NOVEL_ID,
  chapterListItem,
  novelDetail,
  SENTINELS,
} from "./fixtures/admin-content";

const DETAIL = projectAdminNovelDetail(novelDetail());

describe("P2-04 书目详情 · 身份与生命周期", () => {
  it("展示标题、业务 ID、slug、语种与生命周期", () => {
    render(<NovelIdentityPanel novel={DETAIL} />);
    expect(screen.getByText("夜航船")).toBeTruthy();
    expect(screen.getByText("novel-biz-0001")).toBeTruthy();
    expect(screen.getByText("/ye-hang-chuan")).toBeTruthy();
    expect(screen.getByText("en")).toBeTruthy();
    expect(screen.getByTestId("novel-status-published").textContent).toBe("已发布");
    expect(screen.getByText("118 / 上游声明 120")).toBeTruthy();
    expect(screen.getByText("一艘夜里出发的船。")).toBeTruthy();
  });

  it("不展示 author / completionStatus / country / region / 分成比例", () => {
    const { container } = render(<NovelIdentityPanel novel={DETAIL} />);
    const text = container.textContent ?? "";
    for (const sentinel of [
      SENTINELS.author,
      SENTINELS.completionStatus,
      SENTINELS.country,
      SENTINELS.region,
      SENTINELS.splitRatio,
      SENTINELS.coverUrl,
    ]) {
      expect(text, `渲染出了本期禁用字段：${sentinel}`).not.toContain(sentinel);
    }
    expect(container.innerHTML).not.toMatch(/split[_-]?ratio/i);
  });
});

describe("P2-04 书目详情 · 试读授权", () => {
  it("同时给出策略声明与实际落地", () => {
    render(<NovelPreviewPanel novel={DETAIL} />);
    expect(screen.getByText("upstream_returned_preview")).toBeTruthy();
    expect(screen.getByTestId("detail-materialized").textContent).toBe("3");
    expect(screen.getByText("展示授权")).toBeTruthy();
    expect(screen.queryByText("与策略不符")).toBeNull();
  });

  it("策略与实际不符时明确标注", () => {
    const mismatched = projectAdminNovelDetail(
      novelDetail({
        preview: {
          ...novelDetail().preview,
          actualMaterializedChapterCount: 1,
          policyCountMatchesActual: false,
        },
      }),
    );
    render(<NovelPreviewPanel novel={mismatched} />);
    expect(screen.getByText("与策略不符")).toBeTruthy();
  });

  it("没有登记策略时说明原因，而不是显示 0", () => {
    const noPolicy = projectAdminNovelDetail(
      novelDetail({
        preview: {
          policy: null,
          actualMaterializedChapterCount: 2,
          actualDisplayableChapterCount: 1,
          policyCountMatchesActual: null,
        },
      }),
    );
    render(<NovelPreviewPanel novel={noPolicy} />);
    expect(screen.getByTestId("preview-policy-absent")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });
});

describe("P2-04 书目详情 · 同步与异常", () => {
  it("展示最近同步任务、来源覆盖与异常集合", () => {
    render(<NovelSyncPanel novel={DETAIL} />);
    expect(screen.getByText("preview_materialization（执行）")).toBeTruthy();
    expect(screen.getByText("已完成 / 条目 成功")).toBeTruthy();
    expect(screen.getByText("moboreader")).toBeTruthy();
    expect(screen.getByText("无异常")).toBeTruthy();
  });

  it("没有同步记录时明说无记录", () => {
    const noSync = projectAdminNovelDetail(
      novelDetail({
        sync: { ...novelDetail().sync, latest: null, exceptions: ["preview_count_mismatch"] },
      }),
    );
    render(<NovelSyncPanel novel={noSync} />);
    expect(screen.getByTestId("sync-task-absent").textContent).toBe("无同步记录");
    expect(screen.getByTestId("exception-preview_count_mismatch").textContent).toBe(
      "试读计数不符",
    );
  });
});

describe("P2-04 书目详情 · 上游来源", () => {
  it("只展示标识与时间，不展示凭证或原始报文", () => {
    const { container } = render(<NovelSourcesPanel novel={DETAIL} />);
    expect(screen.getByText("up-book-7788")).toBeTruthy();
    expect(screen.getByText("摩宝阅读")).toBeTruthy();

    const html = container.innerHTML;
    for (const forbidden of [
      /encrypted[_-]?secret/i,
      /fingerprint/i,
      /jwt/i,
      /rawPayload/i,
      /channel[_-]?account[_-]?credential/i,
    ]) {
      expect(html, `来源面板出现了禁用字段 ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("来源被截断时给出提示", () => {
    const truncated = projectAdminNovelDetail(novelDetail({ sourcesTruncated: true }));
    render(<NovelSourcesPanel novel={truncated} />);
    expect(screen.getByTestId("sources-truncated")).toBeTruthy();
  });

  it("没有来源条目时不渲染空表", () => {
    const none = projectAdminNovelDetail(novelDetail({ sources: [] }));
    render(<NovelSourcesPanel novel={none} />);
    expect(screen.getByText("暂无来源条目")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

/**
 * P2-06：书目详情页的来源标签面板。
 *
 * fixture `novelDetail()`（`fixtures/admin-content.ts`）登记了三条标签：
 * `series_type/romance`（原值即展示内容）、`language/en`（展示名为 null）、
 * `agency/moboreader`（有展示名"摩宝阅读"）。`recommend` 这个 kind 完全没有
 * 登记，专门用来验证"无标签"占位。
 */
describe("P2-06 书目详情 · 来源标签", () => {
  it("按 LABEL_KINDS 的顺序分组渲染，四个 kind 都出栏", () => {
    render(<NovelLabelsPanel novel={DETAIL} />);
    const labels = screen.getAllByText(/^(题材|推荐位|语言|机构)$/).map((node) => node.textContent);
    expect(labels).toEqual(["题材", "推荐位", "语言", "机构"]);
    expect(LABEL_KINDS).toEqual(["series_type", "recommend", "language", "agency"]);
  });

  it("series_type / recommend 以原值作为主展示，不依赖 displayValue", () => {
    render(<NovelLabelsPanel novel={DETAIL} />);
    const romance = screen.getByTestId("novel-label-24040000-0000-4000-8000-000000000031");
    expect(romance.textContent).toBe("romance");
  });

  it("language / agency 的展示名与原值并列可见", () => {
    render(<NovelLabelsPanel novel={DETAIL} />);
    const agency = screen.getByTestId("novel-label-24040000-0000-4000-8000-000000000033");
    expect(agency.textContent).toContain("摩宝阅读");
    expect(agency.textContent).toContain("moboreader");
  });

  it("language / agency 的 displayValue 缺失时显式标注，raw 只作为原值展示", () => {
    render(<NovelLabelsPanel novel={DETAIL} />);
    const language = screen.getByTestId("novel-label-24040000-0000-4000-8000-000000000032");
    expect(language.textContent).toContain("展示名缺失");
    expect(language.textContent).toContain("原值：en");
    expect(language.textContent).not.toBe("en");
    expect(
      screen.getByTestId(
        "novel-label-display-missing-24040000-0000-4000-8000-000000000032",
      ),
    ).toBeTruthy();
  });

  it("某个 kind 在该书目下没有标签时，渲染显式的「无标签」占位，而不是留空", () => {
    render(<NovelLabelsPanel novel={DETAIL} />);
    // fixture 没有登记任何 recommend kind 的标签
    expect(screen.getByText("无标签")).toBeTruthy();
  });

  it("面板整体只读：没有链接，没有按钮", () => {
    const { container } = render(<NovelLabelsPanel novel={DETAIL} />);
    expect(container.querySelectorAll("a").length).toBe(0);
    expect(container.querySelectorAll("button").length).toBe(0);
  });
});

describe("P2-04 章节列表", () => {
  const CHAPTERS = [
    chapterListItem(),
    chapterListItem({
      id: "24040000-0000-4000-8000-000000000102",
      canonicalChapterNumber: 2,
      title: null,
      status: "locked",
      hasContent: false,
      charCount: null,
      contentHashPrefix: null,
      materializedAt: null,
    }),
  ].map(projectAdminChapterListItem);

  it("空章节给出明确文案", () => {
    render(<ChaptersTable novelId={NOVEL_ID} chapters={[]} />);
    expect(screen.getByText("该书目暂无章节")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("展示章节号、标题、状态与正文落地情况", () => {
    render(<ChaptersTable novelId={NOVEL_ID} chapters={CHAPTERS} />);
    expect(screen.getByText("第 1 章")).toBeTruthy();
    expect(screen.getByText("第一章 起航")).toBeTruthy();
    expect(screen.getByTestId("chapter-status-preview").textContent).toBe("可试读");
    expect(screen.getByTestId("chapter-status-locked").textContent).toBe("锁定");
    expect(screen.getByText("已落地")).toBeTruthy();
    expect(screen.getByText("未落地")).toBeTruthy();
    expect(screen.getByText("未命名")).toBeTruthy();
    expect(screen.getByText("2480")).toBeTruthy();
    expect(screen.getByText("a1b2c3d4e5f6")).toBeTruthy();
  });

  /** 章节列表绝不能顺带把正文带出来——正文有独立能力位和独立审计。 */
  it("章节列表载荷里没有正文", () => {
    const { container } = render(<ChaptersTable novelId={NOVEL_ID} chapters={CHAPTERS} />);
    expect(Object.keys(CHAPTERS[0])).not.toContain("body");
    expect(container.textContent ?? "").not.toContain("船在午夜离港");
  });

  it("每行只提供查看入口，没有写操作控件", () => {
    const { container } = render(<ChaptersTable novelId={NOVEL_ID} chapters={CHAPTERS} />);
    expect(container.querySelectorAll("button").length).toBe(0);
    expect(container.querySelectorAll("input").length).toBe(0);
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.length).toBe(CHAPTERS.length);
    for (const link of links) {
      expect(link.textContent).toBe("查看");
      expect(link.getAttribute("href")).toMatch(/^\/novels\/[0-9a-f-]+\/chapters\/[0-9a-f-]+$/);
    }
  });
});
