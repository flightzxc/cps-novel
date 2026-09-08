import "./setup-cleanup";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installDialogShim } from "./jsdom-dialog";

installDialogShim();

/**
 * M7 admin UI bite tests (交接提示词 B-2) + N-7 (optimistic lock threaded
 * from the row/article prop into the Server Action call). Same discipline as
 * `tests/ui/templates-admin.test.tsx`: only the Server Action module and
 * `next/navigation` are replaced, the real components drive the assertions.
 *
 * M7's actual filtering (`locale`/`status`/`novelId`/`templateId`) landed in
 * `@/server/articles`'s `listArticles` (lane D); its own validation and
 * filter-combination coverage lives in `tests/backend/articles/service.test.ts`
 * (a backend concern — building a real Prisma `where` clause), not here. This
 * file's own `ArticleFilters · M7 filters` block below only bite-tests the
 * form component: field names match the query-string keys `page.tsx` reads,
 * and current values round-trip into `defaultValue`.
 */

const listActions = vi.hoisted(() => ({
  regenerateArticleAction: vi.fn(),
  regenerateArticlesBatchAction: vi.fn(),
  publishArticleAction: vi.fn(),
  withdrawArticleAction: vi.fn(),
  publishArticlesBatchAction: vi.fn(),
}));

const editorActions = vi.hoisted(() => ({
  updateArticleAction: vi.fn(),
}));

const routerRefresh = vi.hoisted(() => vi.fn());

vi.mock("@/app/(admin)/articles/_actions", () => ({ ...listActions, ...editorActions }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

import { ArticleList, type ArticleListRow } from "@/app/(admin)/articles/_components/article-list";
import { ArticleEditor } from "@/app/(admin)/articles/_components/article-editor";
import { ArticleFilters } from "@/app/(admin)/articles/_components/article-filters";

const PUBLIC_ORIGIN = "https://novel.test";

const DRAFT_ROW: ArticleListRow = {
  id: "article-1",
  title: "Draft Article",
  locale: "en",
  slug: "draft-article",
  publicPageShortId: "AbCdEf12",
  status: "draft",
  summary: "A draft summary",
  templateKey: "tpl-1",
  updatedAt: "2026-09-05T02:00:00.000Z",
  // C-20 additions
  createdAt: "2026-09-01T00:00:00.000Z",
  templateName: "标准模板",
  novel: { id: "novel-1", title: "重生之名" },
  canonicalTags: ["言情", "重生"],
};

const PUBLISHED_ROW: ArticleListRow = {
  ...DRAFT_ROW,
  id: "article-2",
  title: "Published Article",
  status: "published",
  updatedAt: "2026-09-05T02:30:00.000Z",
};

const UNPUBLISHED_ROW: ArticleListRow = {
  ...DRAFT_ROW,
  id: "article-3",
  title: "Unpublished Article",
  status: "unpublished",
  updatedAt: "2026-09-05T03:00:00.000Z",
};

const TAKEDOWN_ROW: ArticleListRow = {
  ...DRAFT_ROW,
  id: "article-4",
  title: "Takedown Article",
  status: "takedown",
  updatedAt: "2026-09-05T03:30:00.000Z",
};

beforeEach(() => {
  listActions.regenerateArticleAction.mockReset();
  listActions.regenerateArticlesBatchAction.mockReset();
  listActions.publishArticleAction.mockReset();
  listActions.withdrawArticleAction.mockReset();
  listActions.publishArticlesBatchAction.mockReset();
  editorActions.updateArticleAction.mockReset();
  routerRefresh.mockReset();
});

function dialog(): HTMLDialogElement | null {
  return document.querySelector("dialog");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ArticleList · 列表与批量", () => {
  it("渲染标题/状态/模板", () => {
    render(<ArticleList rows={[DRAFT_ROW, PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    expect(screen.getByText("Draft Article")).toBeTruthy();
    expect(screen.getByText("Published Article")).toBeTruthy();
  });

  /**
   * C-20 (`分析_文章管理Parity缺口_2026-09-08.md` §六, item #20): CPS renders
   * the 前台 URL column regardless of status — drafts can be previewed too —
   * so the old `row.status === "published"` gate on this column is gone.
   * Pins that a draft row's "打开" link and path text render exactly like a
   * published row's.
   */
  it("草稿行也渲染前台 URL 列（打开链接 + 路径文本），不再要求已发布", () => {
    render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    expect(screen.getByText("打开")).toBeTruthy();
    expect(screen.getByTestId(`article-url-path-${DRAFT_ROW.id}`).textContent).toBe(
      `/novel/${DRAFT_ROW.slug}-p${DRAFT_ROW.publicPageShortId}`,
    );
  });

  /**
   * RC-9 regression: the console and the public site are different origins,
   * and the admin origin 404s every public content path. A site-relative href
   * would resolve against the admin host — exactly the 404 this pins against.
   */
  it("前台 URL「打开」链接指向 SITE_URL 公开域，而非当前后台域（RC-9）", () => {
    render(<ArticleList rows={[PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    const link = screen.getByText("打开") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      `${PUBLIC_ORIGIN}/novel/${PUBLISHED_ROW.slug}-p${PUBLISHED_ROW.publicPageShortId}`,
    );
  });

  it("publicOrigin 缺失时退回站内相对路径，不渲染 null 前缀", () => {
    render(<ArticleList rows={[PUBLISHED_ROW]} canWrite publicOrigin={null} />);
    const link = screen.getByText("打开") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      `/novel/${PUBLISHED_ROW.slug}-p${PUBLISHED_ROW.publicPageShortId}`,
    );
  });

  /**
   * 复制按钮复制的是**服务端解析下来的公开源**拼出的绝对 URL，而不是浏览器
   * 当前 origin（后台跑在独立的管理主机上，那个 origin 对所有公开路径都返
   * 404 —— C-18/RC-9 已经确立的约束）。`navigator.clipboard` 在 jsdom 里
   * 默认不存在，这里手动挂一个可断言的 spy。
   */
  it("复制按钮调用剪贴板，且内容以公开源开头（不是后台 origin）", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<ArticleList rows={[PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    fireEvent.click(screen.getByText("复制"));

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied.startsWith(PUBLIC_ORIGIN)).toBe(true);
    expect(copied).toBe(`${PUBLIC_ORIGIN}/novel/${PUBLISHED_ROW.slug}-p${PUBLISHED_ROW.publicPageShortId}`);
  });

  it("状态列渲染中文徽章而不是裸英文状态码", () => {
    render(<ArticleList rows={[DRAFT_ROW, PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    expect(screen.getByTestId("article-status-draft").textContent).toBe("草稿");
    expect(screen.getByTestId("article-status-published").textContent).toBe("已发布");
    expect(screen.queryByText("draft")).toBeNull();
    expect(screen.queryByText("published")).toBeNull();
  });

  it("模板列显示模板名，缺失时回退 key，再缺失显示未绑定", () => {
    render(
      <ArticleList
        rows={[
          DRAFT_ROW,
          { ...DRAFT_ROW, id: "no-name", templateName: null },
          { ...DRAFT_ROW, id: "no-template", templateKey: null, templateName: undefined },
        ]}
        canWrite
        publicOrigin={PUBLIC_ORIGIN}
      />,
    );
    expect(screen.getByText("标准模板")).toBeTruthy();
    expect(screen.getByText("tpl-1")).toBeTruthy();
    expect(screen.getByText("未绑定")).toBeTruthy();
  });

  it("书目列显示书名并链接到书目详情页；分类列显示标签，无分类时显示「无分类」", () => {
    render(
      <ArticleList
        rows={[DRAFT_ROW, { ...DRAFT_ROW, id: "no-tags", novel: { id: "novel-2", title: "另一本书" }, canonicalTags: [] }]}
        canWrite
        publicOrigin={PUBLIC_ORIGIN}
      />,
    );
    const novelLink = screen.getByTestId(`article-novel-link-${DRAFT_ROW.id}`) as HTMLAnchorElement;
    expect(novelLink.textContent).toBe("重生之名");
    expect(novelLink.getAttribute("href")).toBe(`/novels/${DRAFT_ROW.novel!.id}`);
    expect(screen.getByText("言情")).toBeTruthy();
    expect(screen.getByText("重生")).toBeTruthy();
    expect(screen.getByText("无分类")).toBeTruthy();
  });

  it("标题格下补 slug 与短码", () => {
    render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    expect(screen.getByText(`/${DRAFT_ROW.slug}`)).toBeTruthy();
    expect(screen.getByTestId(`article-short-id-${DRAFT_ROW.id}`).textContent).toBe(DRAFT_ROW.publicPageShortId);
  });

  it("创建时间列用统一的时间格式化渲染（Asia/Shanghai）", () => {
    render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    // DRAFT_ROW.createdAt = 2026-09-01T00:00:00.000Z → Shanghai 08:00。
    expect(screen.getByText(/08:00/)).toBeTruthy();
  });

  it("八列表头齐全（标题/书目/模板/分类/状态/前台 URL/创建时间/操作）", () => {
    const { container } = render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    const headers = Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent);
    // 第一列是表头全选 checkbox（无文本），其余八列依次对应。
    expect(headers.slice(1)).toEqual(["标题", "书目", "模板", "分类", "状态", "前台 URL", "创建时间", "操作"]);
  });

  it("勾选行驱动已选计数，上限 50", () => {
    render(<ArticleList rows={[DRAFT_ROW, PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    expect(screen.getByText("已选择 0 / 50")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(`选择 ${DRAFT_ROW.title}`));
    expect(screen.getByText("已选择 1 / 50")).toBeTruthy();
  });

  it("单行再生成：expectedUpdatedAt 取该行的 updatedAt（N-7）", async () => {
    listActions.regenerateArticleAction.mockResolvedValue({ ok: true, data: { outcome: "regenerated" } });
    render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    fireEvent.click(screen.getByText("再生成"));
    await vi.waitFor(() => expect(listActions.regenerateArticleAction).toHaveBeenCalledTimes(1));
    expect(listActions.regenerateArticleAction.mock.calls[0]![0]).toMatchObject({
      articleId: DRAFT_ROW.id,
      expectedUpdatedAt: DRAFT_ROW.updatedAt,
    });
    await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
  });

  it("单行再生成遇到 conflict outcome 时给出可读提示", async () => {
    listActions.regenerateArticleAction.mockResolvedValue({ ok: true, data: { outcome: "conflict" } });
    render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    fireEvent.click(screen.getByText("再生成"));
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("已被其他操作人修改"));
  });

  it("批量再生成调用 regenerateArticlesBatchAction 并携带已选 id", async () => {
    listActions.regenerateArticlesBatchAction.mockResolvedValue({
      ok: true,
      data: { counts: { regenerated: 1, skipped: 0, failed: 0, not_processed: 0 } },
    });
    render(<ArticleList rows={[DRAFT_ROW, PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    fireEvent.click(screen.getByLabelText(`选择 ${DRAFT_ROW.title}`));
    fireEvent.click(screen.getByText("批量再生成"));
    await vi.waitFor(() => expect(listActions.regenerateArticlesBatchAction).toHaveBeenCalledTimes(1));
    expect(listActions.regenerateArticlesBatchAction.mock.calls[0]![0].articleIds).toEqual([DRAFT_ROW.id]);
    await vi.waitFor(() => expect(screen.getByText(/成功 1/)).toBeTruthy());
  });

  it("canWrite=false 时批量按钮禁用", () => {
    render(<ArticleList rows={[DRAFT_ROW]} canWrite={false} publicOrigin={PUBLIC_ORIGIN} />);
    expect((screen.getByText("批量再生成") as HTMLButtonElement).disabled).toBe(true);
  });

  it("表头「选择当前页」全选后已选择 2 / 50，再点一次归零（C-17）", () => {
    render(<ArticleList rows={[DRAFT_ROW, PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    const header = screen.getByLabelText("选择当前页");
    fireEvent.click(header);
    expect(screen.getByText("已选择 2 / 50")).toBeTruthy();
    fireEvent.click(header);
    expect(screen.getByText("已选择 0 / 50")).toBeTruthy();
  });

  /**
   * C-21 (`分析_文章管理Parity缺口_2026-09-08.md` §六, items #24/#25): CPS
   * parity is "草稿显示发布，已发布显示下线" — 已下线/已撤回两态两个按钮都不
   * 出现（既不是可发布的草稿，也不是可下线的已发布）。
   */
  describe("行内 发布 / 下线 按钮可见性（C-21）", () => {
    it("草稿行只显示发布按钮，不显示下线", () => {
      render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      expect(screen.getByTestId(`article-publish-${DRAFT_ROW.id}`)).toBeTruthy();
      expect(screen.queryByTestId(`article-withdraw-${DRAFT_ROW.id}`)).toBeNull();
    });

    it("已发布行只显示下线按钮，不显示发布", () => {
      render(<ArticleList rows={[PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      expect(screen.getByTestId(`article-withdraw-${PUBLISHED_ROW.id}`)).toBeTruthy();
      expect(screen.queryByTestId(`article-publish-${PUBLISHED_ROW.id}`)).toBeNull();
    });

    it("已下线 / 已撤回行两个按钮都不显示", () => {
      render(<ArticleList rows={[UNPUBLISHED_ROW, TAKEDOWN_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      for (const row of [UNPUBLISHED_ROW, TAKEDOWN_ROW]) {
        expect(screen.queryByTestId(`article-publish-${row.id}`)).toBeNull();
        expect(screen.queryByTestId(`article-withdraw-${row.id}`)).toBeNull();
      }
    });

    it("canWrite=false 时发布/下线按钮均禁用", () => {
      render(<ArticleList rows={[DRAFT_ROW, PUBLISHED_ROW]} canWrite={false} publicOrigin={PUBLIC_ORIGIN} />);
      expect((screen.getByTestId(`article-publish-${DRAFT_ROW.id}`) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId(`article-withdraw-${PUBLISHED_ROW.id}`) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe("行内「发布」（C-21）", () => {
    it("发布成功（首次公开）：调用 publishArticleAction 并携带 articleId，刷新列表", async () => {
      listActions.publishArticleAction.mockResolvedValue({
        ok: true,
        data: { outcome: "published", articleId: DRAFT_ROW.id, novelId: "novel-1", locale: "en", firstPublish: true },
      });
      render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      fireEvent.click(screen.getByTestId(`article-publish-${DRAFT_ROW.id}`));
      await vi.waitFor(() => expect(listActions.publishArticleAction).toHaveBeenCalledTimes(1));
      expect(listActions.publishArticleAction.mock.calls[0]![0]).toMatchObject({ articleId: DRAFT_ROW.id });
      await vi.waitFor(() => expect(screen.getByText(/首次公开/)).toBeTruthy());
      await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    });

    it("发布被门禁拒绝（rejected outcome）时展示可读的拒绝原因，而不是裸 reason 码", async () => {
      listActions.publishArticleAction.mockResolvedValue({
        ok: true,
        data: { outcome: "rejected", gate: { publishable: false, reasons: ["preview_chapter_missing"] } },
      });
      render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      fireEvent.click(screen.getByTestId(`article-publish-${DRAFT_ROW.id}`));
      await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("没有可信试读章节"));
      expect(screen.queryByText(/preview_chapter_missing/)).toBeNull();
    });

    it("发布遇到 conflict outcome 时给出可读提示，不刷新", async () => {
      listActions.publishArticleAction.mockResolvedValue({ ok: true, data: { outcome: "conflict" } });
      render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      fireEvent.click(screen.getByTestId(`article-publish-${DRAFT_ROW.id}`));
      await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("并发修改"));
      expect(routerRefresh).not.toHaveBeenCalled();
    });

    it("Server Action 返回 ok:false 时展示错误码", async () => {
      listActions.publishArticleAction.mockResolvedValue({ ok: false, code: "article_publish_failed" });
      render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      fireEvent.click(screen.getByTestId(`article-publish-${DRAFT_ROW.id}`));
      await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("article_publish_failed"));
    });
  });

  /**
   * C-21 row-level "下线" (analysis doc item #25 — ADAPT: 带审计理由的对话
   * 框，不是 CPS 那种点了就切换). Same "未填理由不提交" discipline as
   * `tests/ui/novel-publish-lifecycle-panel.test.tsx`'s takedown/withdraw
   * dialog tests, copied onto this row-level control.
   */
  describe("行内「下线」确认对话框（C-21）", () => {
    it("点击下线打开确认对话框，展示书名", async () => {
      render(<ArticleList rows={[PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId(`article-withdraw-${PUBLISHED_ROW.id}`));
      });
      await waitFor(() => expect(dialog()?.open).toBe(true));
      expect(dialog()!.textContent).toContain(PUBLISHED_ROW.title);
    });

    it("未填理由点击确认不提交，不调用 withdrawArticleAction，对话框保持打开并展示校验提示", async () => {
      render(<ArticleList rows={[PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId(`article-withdraw-${PUBLISHED_ROW.id}`));
      });
      await waitFor(() => expect(dialog()?.open).toBe(true));
      await act(async () => {
        fireEvent.click(within(dialog()!).getByRole("button", { name: "下线" }));
      });
      expect(listActions.withdrawArticleAction).not.toHaveBeenCalled();
      expect(dialog()?.open).toBe(true);
      expect(screen.getByTestId("article-withdraw-reason-error")).toBeTruthy();
    });

    it("填写理由后确认，调用 withdrawArticleAction 并携带 trim 后的理由与该行的 novelId，成功后刷新", async () => {
      listActions.withdrawArticleAction.mockResolvedValue({
        ok: true,
        data: { novelId: "novel-1", novelStatus: "unpublished", affectedArticleIds: [PUBLISHED_ROW.id] },
      });
      render(<ArticleList rows={[PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId(`article-withdraw-${PUBLISHED_ROW.id}`));
      });
      await waitFor(() => expect(dialog()?.open).toBe(true));
      fireEvent.change(screen.getByLabelText("下线原因"), { target: { value: "  运营决定临时下线  " } });
      await act(async () => {
        fireEvent.click(within(dialog()!).getByRole("button", { name: "下线" }));
      });
      expect(listActions.withdrawArticleAction).toHaveBeenCalledWith(
        expect.objectContaining({ novelId: "novel-1", reason: "运营决定临时下线" }),
      );
      await vi.waitFor(() => expect(screen.getByText(/受影响文章数：1/)).toBeTruthy());
      expect(routerRefresh).toHaveBeenCalled();
    });

    it("取消关闭确认框且不调用 Action", async () => {
      render(<ArticleList rows={[PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId(`article-withdraw-${PUBLISHED_ROW.id}`));
      });
      await waitFor(() => expect(dialog()?.open).toBe(true));
      await act(async () => {
        fireEvent.click(within(dialog()!).getByRole("button", { name: "取消" }));
      });
      expect(dialog()?.open).toBe(false);
      expect(listActions.withdrawArticleAction).not.toHaveBeenCalled();
    });
  });

  describe("列表批量发布（C-21）", () => {
    it("批量发布调用 publishArticlesBatchAction 并携带已选 id，成功后清空选择并刷新", async () => {
      listActions.publishArticlesBatchAction.mockResolvedValue({
        ok: true,
        data: {
          results: [
            { articleId: DRAFT_ROW.id, result: { outcome: "published", articleId: DRAFT_ROW.id, novelId: "novel-1", locale: "en", firstPublish: false } },
          ],
        },
      });
      render(<ArticleList rows={[DRAFT_ROW, PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      fireEvent.click(screen.getByLabelText(`选择 ${DRAFT_ROW.title}`));
      fireEvent.click(screen.getByTestId("articles-batch-publish"));
      await vi.waitFor(() => expect(listActions.publishArticlesBatchAction).toHaveBeenCalledTimes(1));
      expect(listActions.publishArticlesBatchAction.mock.calls[0]![0].articleIds).toEqual([DRAFT_ROW.id]);
      await vi.waitFor(() => expect(screen.getByText(/成功 1/)).toBeTruthy());
      expect(screen.getByText("已选择 0 / 50")).toBeTruthy();
      expect(routerRefresh).toHaveBeenCalled();
    });

    it("canWrite=false 时批量发布按钮禁用", () => {
      render(<ArticleList rows={[DRAFT_ROW]} canWrite={false} publicOrigin={PUBLIC_ORIGIN} />);
      expect((screen.getByTestId("articles-batch-publish") as HTMLButtonElement).disabled).toBe(true);
    });

    it("50 条/25 秒预算说明紧邻批量再生成按钮（C-22），而不是抬头文案", () => {
      render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      expect(screen.getByText("50 条/25 秒预算")).toBeTruthy();
    });
  });

  /**
   * C-21 EXCLUDE (analysis doc item #27): "一对一绑定，删除即永久失去公开页
   * 且无法从目录同步重建" — pins the decision so a future change cannot
   * "顺手补上" a delete control without this test failing first.
   */
  it("列表中不存在任何删除按钮（C-21 EXCLUDE，含批量删除）", () => {
    render(
      <ArticleList
        rows={[DRAFT_ROW, PUBLISHED_ROW, UNPUBLISHED_ROW, TAKEDOWN_ROW]}
        canWrite
        publicOrigin={PUBLIC_ORIGIN}
      />,
    );
    expect(screen.queryByText("删除")).toBeNull();
    expect(screen.queryByText("批量删除")).toBeNull();
    expect(screen.queryByText(/^删除/)).toBeNull();
  });

  /**
   * C-22 (`分析_文章管理Parity缺口_2026-09-08.md` §六, item #31, PORT): CPS's
   * empty state is "暂无文章" + "去生成第一篇文章" → `/articles/generate`.
   * cps-novel's ADAPTed creation entry is `/catalog-sync` (same route the
   * page header's "新建文章"/"批量新建" buttons point at, `../page.tsx`).
   */
  it("空列表展示「去创建第一篇文章」引导链接，指向目录同步", () => {
    render(<ArticleList rows={[]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    expect(screen.getByText("暂无文章")).toBeTruthy();
    const link = screen.getByText("去创建第一篇文章") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/catalog-sync");
  });
});

const ARTICLE = {
  id: "article-1",
  title: "Some Title",
  summary: "Some summary",
  body: "<p>Body content</p>",
  seoMetadata: { metaTitle: "Meta title", metaDescription: "Meta description" },
  slug: "some-slug",
  publicPageShortId: "AbCdEf12",
  updatedAt: "2026-09-05T02:00:00.000Z",
};

describe("ArticleEditor · 编辑与预览", () => {
  it("渲染 slug/shortId 只读展示与正文预览", () => {
    render(<ArticleEditor article={ARTICLE} canWrite />);
    expect(screen.getByText(/slug: some-slug/)).toBeTruthy();
    expect(screen.getByText(/shortId: AbCdEf12/)).toBeTruthy();
    expect(screen.getByText("Body content")).toBeTruthy();
  });

  it("提交时把 article.updatedAt 作为 expectedUpdatedAt 传给 updateArticleAction（N-7）", async () => {
    editorActions.updateArticleAction.mockResolvedValue({ ok: true });
    render(<ArticleEditor article={ARTICLE} canWrite />);
    fireEvent.click(screen.getByText("保存"));
    await vi.waitFor(() => expect(editorActions.updateArticleAction).toHaveBeenCalledTimes(1));
    expect(editorActions.updateArticleAction.mock.calls[0]![0]).toMatchObject({
      articleId: ARTICLE.id,
      expectedUpdatedAt: ARTICLE.updatedAt,
    });
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("已保存"));
  });

  it("conflict 错误码渲染为可读中文提示而不是裸错误码", async () => {
    editorActions.updateArticleAction.mockResolvedValue({ ok: false, code: "article_conflict" });
    render(<ArticleEditor article={ARTICLE} canWrite />);
    fireEvent.click(screen.getByText("保存"));
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("已被其他操作人修改"));
  });

  it("正文编辑同步更新预览", () => {
    render(<ArticleEditor article={ARTICLE} canWrite />);
    const textarea = screen.getByDisplayValue("<p>Body content</p>") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "<p>Updated</p>" } });
    expect(screen.getByText("Updated")).toBeTruthy();
  });

  it("canWrite=false 时保存按钮禁用", () => {
    render(<ArticleEditor article={ARTICLE} canWrite={false} />);
    expect((screen.getByText("保存") as HTMLButtonElement).disabled).toBe(true);
  });
});

const LOCALES = ["en", "fr"];
const CATEGORY_OPTIONS = [
  { id: "11111111-1111-4111-8111-111111111111", label: "言情" },
  { id: "22222222-2222-4222-8222-222222222222", label: "romance-no-zh" },
];
const TEMPLATE_OPTIONS = [
  { id: "33333333-3333-4333-8333-333333333333", templateKey: "tpl-a", locale: "en", version: 2 },
  { id: "44444444-4444-4444-8444-444444444444", templateKey: "tpl-b", locale: null, version: 1 },
];

describe("ArticleFilters · C-19 filters", () => {
  it("字段 name 属性与 page.tsx 读取的 query-string key 一致（含新增的 search/canonicalTagId）", () => {
    render(
      <ArticleFilters
        values={{}}
        locales={LOCALES}
        categoryOptions={CATEGORY_OPTIONS}
        templateOptions={TEMPLATE_OPTIONS}
      />,
    );
    expect((screen.getByLabelText("搜索") as HTMLInputElement).name).toBe("search");
    expect((screen.getByLabelText("语种") as HTMLSelectElement).name).toBe("locale");
    expect((screen.getByLabelText("状态") as HTMLSelectElement).name).toBe("status");
    expect((screen.getByLabelText("分类") as HTMLSelectElement).name).toBe("canonicalTagId");
    expect((screen.getByLabelText("模板") as HTMLSelectElement).name).toBe("templateId");
  });

  it("当前筛选值回填为 defaultValue，而不是每次都从空表单开始", () => {
    render(
      <ArticleFilters
        values={{
          search: "moonlight",
          locale: "en",
          status: "published",
          canonicalTagId: CATEGORY_OPTIONS[0]!.id,
          templateId: TEMPLATE_OPTIONS[0]!.id,
        }}
        locales={LOCALES}
        categoryOptions={CATEGORY_OPTIONS}
        templateOptions={TEMPLATE_OPTIONS}
      />,
    );
    expect((screen.getByLabelText("搜索") as HTMLInputElement).value).toBe("moonlight");
    expect((screen.getByLabelText("语种") as HTMLSelectElement).value).toBe("en");
    expect((screen.getByLabelText("状态") as HTMLSelectElement).value).toBe("published");
    expect((screen.getByLabelText("分类") as HTMLSelectElement).value).toBe(CATEGORY_OPTIONS[0]!.id);
    expect((screen.getByLabelText("模板") as HTMLSelectElement).value).toBe(TEMPLATE_OPTIONS[0]!.id);
  });

  it("状态下拉渲染文章四态而不是书目五态（没有 ready）", () => {
    render(
      <ArticleFilters values={{}} locales={LOCALES} categoryOptions={CATEGORY_OPTIONS} templateOptions={TEMPLATE_OPTIONS} />,
    );
    const select = screen.getByLabelText("状态") as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((option) => option.textContent);
    expect(optionLabels).toEqual(["全部状态", "草稿", "已发布", "已下线", "已撤回"]);
  });

  it("语种下拉只渲染传入的 locales（库里真实出现过的），不是全量注册表", () => {
    render(
      <ArticleFilters values={{}} locales={["en"]} categoryOptions={CATEGORY_OPTIONS} templateOptions={TEMPLATE_OPTIONS} />,
    );
    const select = screen.getByLabelText("语种") as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((option) => option.textContent);
    expect(optionLabels).toEqual(["全部语种", "en"]);
  });

  it("模板下拉 value 是模板 UUID，文本是 templateKey · v版本号", () => {
    render(
      <ArticleFilters values={{}} locales={LOCALES} categoryOptions={CATEGORY_OPTIONS} templateOptions={TEMPLATE_OPTIONS} />,
    );
    const select = screen.getByLabelText("模板") as HTMLSelectElement;
    const options = Array.from(select.options).slice(1); // 跳过 "全部模板"
    expect(options.map((option) => option.value)).toEqual(TEMPLATE_OPTIONS.map((t) => t.id));
    expect(options.map((option) => option.textContent)).toEqual(["tpl-a · v2", "tpl-b · v1"]);
  });

  it("分类下拉 value 是 Canonical Tag UUID，无 zh 译名时回退 stableId/label", () => {
    render(
      <ArticleFilters values={{}} locales={LOCALES} categoryOptions={CATEGORY_OPTIONS} templateOptions={TEMPLATE_OPTIONS} />,
    );
    const select = screen.getByLabelText("分类") as HTMLSelectElement;
    const options = Array.from(select.options).slice(1); // 跳过 "全部分类"
    expect(options.map((option) => option.value)).toEqual(CATEGORY_OPTIONS.map((tag) => tag.id));
    expect(options.map((option) => option.textContent)).toEqual(["言情", "romance-no-zh"]);
  });

  it("提交是纯 GET 表单，没有 page 字段——切换筛选会把分页重置回第 1 页", () => {
    render(
      <ArticleFilters
        values={{ locale: "en" }}
        locales={LOCALES}
        categoryOptions={CATEGORY_OPTIONS}
        templateOptions={TEMPLATE_OPTIONS}
      />,
    );
    const form = screen.getByRole("search") as HTMLFormElement;
    expect(form.method).toBe("get");
    expect(form.querySelector('input[name="page"]')).toBeNull();
  });

  it("页面上不再存在要求手打 UUID 的输入框——唯一的文本输入是搜索框", () => {
    const { container } = render(
      <ArticleFilters
        values={{ novelId: "novel-1" }}
        locales={LOCALES}
        categoryOptions={CATEGORY_OPTIONS}
        templateOptions={TEMPLATE_OPTIONS}
      />,
    );
    const textInputs = Array.from(container.querySelectorAll('input[type="text"]'));
    expect(textInputs).toHaveLength(1);
    expect(textInputs[0]!.getAttribute("name")).toBe("search");
    // novelId only ever travels as a hidden field once the banner is showing — never as a visible text box.
    expect(container.querySelector('input[name="novelId"]')?.getAttribute("type")).toBe("hidden");
  });

  describe("novelId 提示条（跳转带入 + 清除，代替裸 UUID 输入框）", () => {
    it("novelId 缺失时不渲染提示条，也不带隐藏字段", () => {
      const { container } = render(
        <ArticleFilters values={{}} locales={LOCALES} categoryOptions={CATEGORY_OPTIONS} templateOptions={TEMPLATE_OPTIONS} />,
      );
      expect(screen.queryByTestId("article-novel-filter-banner")).toBeNull();
      expect(container.querySelector('input[name="novelId"]')).toBeNull();
    });

    it("novelId 存在时渲染《书名》提示条，并把 novelId 作为隐藏字段带入表单", () => {
      const { container } = render(
        <ArticleFilters
          values={{ novelId: "novel-1" }}
          novelTitle="重生之名"
          locales={LOCALES}
          categoryOptions={CATEGORY_OPTIONS}
          templateOptions={TEMPLATE_OPTIONS}
        />,
      );
      expect(screen.getByTestId("article-novel-filter-banner").textContent).toContain("《重生之名》");
      const hidden = container.querySelector('input[name="novelId"]') as HTMLInputElement;
      expect(hidden.type).toBe("hidden");
      expect(hidden.value).toBe("novel-1");
    });

    it("novelTitle 未解析出时提示条回退显示原始 novelId，而不是空白", () => {
      render(
        <ArticleFilters
          values={{ novelId: "missing-novel" }}
          novelTitle={null}
          locales={LOCALES}
          categoryOptions={CATEGORY_OPTIONS}
          templateOptions={TEMPLATE_OPTIONS}
        />,
      );
      expect(screen.getByTestId("article-novel-filter-banner").textContent).toContain("《missing-novel》");
    });

    it("清除链接保留其它筛选值，只去掉 novelId", () => {
      render(
        <ArticleFilters
          values={{ novelId: "novel-1", search: "moonlight", status: "published" }}
          locales={LOCALES}
          categoryOptions={CATEGORY_OPTIONS}
          templateOptions={TEMPLATE_OPTIONS}
        />,
      );
      const clear = screen.getByTestId("article-novel-filter-clear") as HTMLAnchorElement;
      const href = clear.getAttribute("href")!;
      expect(href).not.toContain("novelId");
      expect(href).toContain("search=moonlight");
      expect(href).toContain("status=published");
    });
  });
});

/**
 * ArticlesPage (`../page.tsx`) is an async Server Component that queries
 * Prisma and `requireContentPage` directly — like every other admin page in
 * this repo, it has no render-based unit test (nothing under `tests/ui/`
 * imports and renders a `(admin)/**\/page.tsx`; only its client components
 * and services get that treatment, e.g. this file's own `ArticleList`/
 * `ArticleFilters` blocks above). C-22's header-copy and entry-button `href`
 * requirements (`分析_文章管理Parity缺口_2026-09-08.md` §六, items #1/#3/#4)
 * are still worth pinning against silent drift, so this is a source-text
 * assertion in the same spirit as `tests/ui/admin-path-roots-parity.test.ts`
 * — narrower in scope (one page's literal copy, not a cross-file registry),
 * but the same "read the file, assert on its text" mechanism rather than a
 * new one.
 */
describe("ArticlesPage 抬头文案与入口按钮（C-22，源码级断言）", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../../src/app/(admin)/articles/page.tsx"),
    "utf8",
  );

  it("抬头文案照抄 CPS 的「管理所有生成的文章，共 N 篇」，不再夹带 50 条/25 秒预算说明", () => {
    const descriptionMatch = source.match(/description=\{granted \? `([^`]*)` : undefined\}/);
    expect(descriptionMatch?.[1]).toBe("管理所有生成的文章，共 ${total} 篇");
    // The budget note itself only appears in this file's *explanatory
    // comment* about where it moved to — not literally banned from the
    // source text, just from ever landing back inside the `description`
    // template above (asserted precisely, not by a whole-file substring
    // scan that a comment could trivially fail).
  });

  it("「新建文章」与「批量新建」两个入口按钮都指向 /catalog-sync", () => {
    const newArticleIdx = source.indexOf("新建文章");
    const batchNewIdx = source.indexOf("批量新建");
    expect(newArticleIdx).toBeGreaterThan(-1);
    expect(batchNewIdx).toBeGreaterThan(-1);
    // Each label's nearest preceding `href` must be "/catalog-sync" — walks
    // backward from the label text to the `href="..."` that renders it,
    // rather than just counting `/catalog-sync` occurrences (which would
    // pass even if a label drifted onto some other route by accident).
    for (const labelIdx of [newArticleIdx, batchNewIdx]) {
      const before = source.slice(0, labelIdx);
      const hrefMatch = before.match(/href="([^"]*)"(?!.*href=")/s);
      expect(hrefMatch?.[1]).toBe("/catalog-sync");
    }
  });
});

/**
 * C-23 (`分析_文章管理Parity缺口_2026-09-08.md` §六): the remaining
 * navigation-closure leg — an article → novel link back. Novel-detail →
 * article-list (C-19) and article-list → novel-detail (C-20, the 书目
 * column) both already exist; this pins that the article *edit* page
 * (`/articles/[articleId]`, the screen "编辑/预览" actually lands on) also
 * has a way back to the novel and to the list, not just the browser's own
 * Back button. Same source-text-assertion mechanism as the C-22 block above,
 * for the same reason (async Server Component, no render-based unit test
 * precedent for `(admin)/**\/page.tsx` in this repo).
 */
describe("ArticleEditPage 返回导航（C-23）", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../../src/app/(admin)/articles/[articleId]/page.tsx"),
    "utf8",
  );

  it("提供「查看所属书目」链接，指向该文章的 novelId", () => {
    expect(source).toContain('href={`/novels/${article.novel.id}`}');
    expect(source).toContain("查看所属书目");
  });

  it("提供「返回文章列表」链接，指向 /articles", () => {
    const labelIdx = source.indexOf("返回文章列表");
    expect(labelIdx).toBeGreaterThan(-1);
    const before = source.slice(0, labelIdx);
    const hrefMatch = before.match(/href="([^"]*)"(?!.*href=")/s);
    expect(hrefMatch?.[1]).toBe("/articles");
  });
});
