import "./setup-cleanup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectAdminChapterContent, projectAdminChapterDetail } from "@/contracts";
import { ChapterContentViewer } from "@/app/(admin)/novels/_components/chapter-content-viewer";
import {
  ChapterDetailPanel,
  ChapterSourcesPanel,
} from "@/app/(admin)/novels/_components/chapter-detail-panel";
import { ContentCapabilityDenied } from "@/app/(admin)/novels/_components/content-states";

import { CHAPTER_ID, NOVEL_ID, chapterContent, chapterDetail, SENTINELS } from "./fixtures/admin-content";

/**
 * 章节正文的按需读取验收。
 *
 * `adminFetch` 不打桩——stub 的是 `fetch`，让组件走真实的 envelope 解析路径，
 * 于是「拒绝时显示哪句话」测的是真实映射而不是替身的返回值。
 */

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okResponse(payload: unknown) {
  return { json: async () => ({ ok: true, data: payload }) } as unknown as Response;
}

function envelopeResponse(envelope: unknown) {
  return { json: async () => envelope } as unknown as Response;
}

function renderViewer(hasContent = true) {
  return render(
    <ChapterContentViewer novelId={NOVEL_ID} chapterId={CHAPTER_ID} hasContent={hasContent} />,
  );
}

describe("P2-04 章节正文 · 按需读取", () => {
  it("挂载时不请求正文", () => {
    renderViewer();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chapter-content-body")).toBeNull();
    expect(screen.getByRole("button", { name: "读取正文" })).toBeTruthy();
  });

  it("点击后才请求，并命中章节正文专用路由", async () => {
    fetchMock.mockResolvedValue(okResponse(projectAdminChapterContent(chapterContent())));
    renderViewer();

    fireEvent.click(screen.getByRole("button", { name: "读取正文" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    const requested = new URL(String(url), "https://admin.invalid");
    expect(requested.pathname).toBe("/api/admin/novels/chapters/content");
    expect(requested.searchParams.get("novelId")).toBe(NOVEL_ID);
    expect(requested.searchParams.get("chapterId")).toBe(CHAPTER_ID);
    expect((init as RequestInit).method).toBe("GET");
    // 读不是 mutation：不带幂等标识，也不需要 same-origin 令牌
    expect((init as RequestInit & { headers: Record<string, string> }).headers["x-request-id"])
      .toBeUndefined();
  });

  it("请求进行中给出加载态", async () => {
    let resolve: ((value: Response) => void) | undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((r) => {
        resolve = r;
      }),
    );
    renderViewer();
    fireEvent.click(screen.getByRole("button", { name: "读取正文" }));

    await waitFor(() => expect(screen.getByTestId("chapter-content-loading")).toBeTruthy());
    expect(screen.getByTestId("chapter-content-loading").getAttribute("aria-busy")).toBe("true");

    resolve?.(okResponse(projectAdminChapterContent(chapterContent())));
    await waitFor(() => expect(screen.queryByTestId("chapter-content-loading")).toBeNull());
  });

  it("读取成功后渲染正文与元信息，并隐藏读取按钮", async () => {
    fetchMock.mockResolvedValue(okResponse(projectAdminChapterContent(chapterContent())));
    renderViewer();
    fireEvent.click(screen.getByRole("button", { name: "读取正文" }));

    const body = await screen.findByTestId("chapter-content-body");
    expect(body.textContent).toContain("船在午夜离港");
    expect(body.textContent).toContain("字数 2480");
    expect(screen.queryByRole("button", { name: "读取正文" })).toBeNull();
  });

  it("提示每次读取都会留下审计", () => {
    renderViewer();
    expect(screen.getByText("每次读取都会记录一条访问审计。")).toBeTruthy();
  });

  it("正文未落地时不给读取入口", () => {
    renderViewer(false);
    expect(screen.getByTestId("chapter-content-absent")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("不提供编辑、复制原文或原始报文入口", async () => {
    fetchMock.mockResolvedValue(okResponse(projectAdminChapterContent(chapterContent())));
    const { container } = renderViewer();
    fireEvent.click(screen.getByRole("button", { name: "读取正文" }));
    await screen.findByTestId("chapter-content-body");

    // 载入后唯一可能存在的按钮已消失，剩下的只有只读展示
    expect(container.querySelectorAll("button").length).toBe(0);
    expect(container.querySelectorAll("textarea, input, [contenteditable]").length).toBe(0);
    for (const forbidden of ["编辑", "保存", "复制", "原始报文", "raw", "payload"]) {
      expect(
        (container.textContent ?? "").toLowerCase(),
        `正文查看器出现了 ${forbidden}`,
      ).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe("P2-04 章节正文 · 能力位", () => {
  it("被后端以 content:read 拒绝时，显示点名该能力位的文案", async () => {
    fetchMock.mockResolvedValue(
      envelopeResponse({
        ok: false,
        status: 403,
        code: "admin_capability_denied",
        details: { capability: "content:read" },
      }),
    );
    renderViewer();
    fireEvent.click(screen.getByRole("button", { name: "读取正文" }));

    const error = await screen.findByTestId("chapter-content-error");
    expect(error.textContent).toContain("content:read");
    expect(error.textContent).toContain("章节正文读取");
    expect(screen.queryByTestId("chapter-content-body")).toBeNull();
  });

  it("章节不存在时给出不存在的文案，而不是权限文案", async () => {
    fetchMock.mockResolvedValue(
      envelopeResponse({ ok: false, status: 404, code: "admin_content_not_found" }),
    );
    renderViewer();
    fireEvent.click(screen.getByRole("button", { name: "读取正文" }));

    const error = await screen.findByTestId("chapter-content-error");
    expect(error.textContent).toContain("该内容不存在或已被删除");
  });

  it("被拒时页面仍然告诉操作者缺哪个能力位，且不提 2FA", () => {
    render(<ContentCapabilityDenied capability="content:read" />);
    const panel = screen.getByTestId("content-capability-denied");
    expect(panel.textContent).toContain("content:read");
    expect(panel.textContent).not.toContain("双重验证");
    expect(panel.textContent).not.toContain("2FA");
  });
});

describe("P2-04 章节元信息", () => {
  const CHAPTER = projectAdminChapterDetail(chapterDetail());

  it("展示章节号、状态、字数与指纹前缀", () => {
    render(<ChapterDetailPanel chapter={CHAPTER} />);
    expect(screen.getByText("第 1 章")).toBeTruthy();
    expect(screen.getByTestId("chapter-status-preview").textContent).toBe("可试读");
    expect(screen.getByText("2480")).toBeTruthy();
    expect(screen.getByText("a1b2c3d4e5f6")).toBeTruthy();
  });

  /** 完整 content_hash 不出页面：只给前 12 位，够肉眼比对，不够当键用。 */
  it("只暴露 12 位指纹前缀，不暴露完整 hash", () => {
    const { container } = render(<ChapterDetailPanel chapter={CHAPTER} />);
    expect(CHAPTER.contentHashPrefix).toBe("a1b2c3d4e5f6");
    expect(container.textContent ?? "").not.toContain(SENTINELS.contentHashTail);
  });

  it("元信息里没有正文字段", () => {
    const { container } = render(<ChapterDetailPanel chapter={CHAPTER} />);
    expect(Object.keys(CHAPTER)).not.toContain("body");
    expect(container.textContent ?? "").not.toContain("船在午夜离港");
  });

  it("上游来源只给标识与时间", () => {
    const { container } = render(<ChapterSourcesPanel chapter={CHAPTER} />);
    expect(screen.getByText("up-chapter-1")).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/encrypted|fingerprint|jwt|payload/i);
  });
});
