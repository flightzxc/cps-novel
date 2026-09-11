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
import { ArticleBlogEditor } from "@/app/(admin)/articles/_components/article-blog-editor";
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
   * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
   * "仅需确认列表里博客行的'前台 URL'列渲染的是 /blog/{slug}" — this pins
   * that confirmation. Before this round's fix, `publicArticlePath` always
   * called `buildArticlePath` (the `/novel/{slug}-p{shortId}` family)
   * regardless of `row.articleType`, which would have rendered a broken
   * `/novel/{blog-slug}-p{shortId}` link for a blog row — no short code,
   * wrong route.
   */
  it("博客行的前台 URL 列渲染 /blog/{slug}（无短码），而不是 /novel/{slug}-p{shortId}", () => {
    const blogRow: ArticleListRow = {
      ...DRAFT_ROW,
      id: "blog-article-1",
      title: "A blog post",
      slug: "a-blog-post",
      articleType: "blog_article",
      novel: undefined,
    };
    render(<ArticleList rows={[blogRow]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    expect(screen.getByTestId(`article-url-path-${blogRow.id}`).textContent).toBe("/blog/a-blog-post");
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

  it("十一列表头齐全（标题/书目/模板/分类/类型/内容模式/状态/SEO 可见性/前台 URL/创建时间/操作）", () => {
    const { container } = render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    const headers = Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent);
    // 第一列是表头全选 checkbox（无文本），其余十一列依次对应。C-25 在「状态」与
    // 「前台 URL」之间插入了「SEO 可见性」列；C-26 在「分类」与「状态」之间插入了
    // 「类型」「内容模式」两列。
    expect(headers.slice(1)).toEqual([
      "标题",
      "书目",
      "模板",
      "分类",
      "类型",
      "内容模式",
      "状态",
      "SEO 可见性",
      "前台 URL",
      "创建时间",
      "操作",
    ]);
  });

  /**
   * C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
   * "表格新增「SEO 可见性」徽章列" — CPS wording (公开/仅 SEO/隐藏), not the raw
   * column value. Also pins the `seoVisibility` field's additive-contract
   * fallback: a row built without it (pre-C-25 caller shape) must still
   * render, defaulting to `public` rather than crashing or showing blank.
   */
  it("SEO 可见性列渲染 CPS 中文徽章，缺字段时回退为「公开」", () => {
    render(
      <ArticleList
        rows={[
          { ...DRAFT_ROW, id: "row-public", seoVisibility: "public" },
          { ...DRAFT_ROW, id: "row-seo-only", seoVisibility: "seo_only" },
          { ...DRAFT_ROW, id: "row-hidden", seoVisibility: "hidden" },
          { ...DRAFT_ROW, id: "row-missing", seoVisibility: undefined },
        ]}
        canWrite
        publicOrigin={PUBLIC_ORIGIN}
      />,
    );
    expect(screen.getAllByTestId("article-seo-visibility-public")).toHaveLength(2); // row-public + row-missing fallback
    expect(screen.getByTestId("article-seo-visibility-seo_only").textContent).toBe("仅 SEO");
    expect(screen.getByTestId("article-seo-visibility-hidden").textContent).toBe("隐藏");
    expect(screen.queryByText("seo_only")).toBeNull();
    expect(screen.queryByText("hidden")).toBeNull();
  });

  /**
   * C-26 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-26):
   * "表格新增「类型」和「内容模式」两个徽章列" — pins CPS-wording Chinese
   * badges (not raw codes) plus the additive-contract fallback: a row built
   * without `articleType`/`contentMode` must still render, defaulting to the
   * same values the DB column itself defaults to (`novel_article`/
   * `template`, C-24) rather than crashing or showing blank.
   */
  it("类型列渲染 CPS 中文徽章，缺字段时回退为「小说文章」", () => {
    render(
      <ArticleList
        rows={[
          { ...DRAFT_ROW, id: "row-novel", articleType: "novel_article" },
          { ...DRAFT_ROW, id: "row-blog", articleType: "blog_article" },
          { ...DRAFT_ROW, id: "row-listicle", articleType: "listicle" },
          { ...DRAFT_ROW, id: "row-guide", articleType: "guide" },
          { ...DRAFT_ROW, id: "row-missing", articleType: undefined },
        ]}
        canWrite
        publicOrigin={PUBLIC_ORIGIN}
      />,
    );
    expect(screen.getAllByTestId("article-type-novel_article")).toHaveLength(2); // row-novel + row-missing fallback
    expect(screen.getByTestId("article-type-blog_article").textContent).toBe("博客文章");
    expect(screen.getByTestId("article-type-listicle").textContent).toBe("榜单 / Listicle");
    expect(screen.getByTestId("article-type-guide").textContent).toBe("指南 / Guide");
    expect(screen.queryByText("novel_article")).toBeNull();
    expect(screen.queryByText("blog_article")).toBeNull();
  });

  it("内容模式列渲染 CPS 中文徽章，缺字段时回退为「使用模板」", () => {
    render(
      <ArticleList
        rows={[
          { ...DRAFT_ROW, id: "row-template", contentMode: "template" },
          { ...DRAFT_ROW, id: "row-manual", contentMode: "manual" },
          { ...DRAFT_ROW, id: "row-missing", contentMode: undefined },
        ]}
        canWrite
        publicOrigin={PUBLIC_ORIGIN}
      />,
    );
    expect(screen.getAllByTestId("article-content-mode-template")).toHaveLength(2); // row-template + row-missing fallback
    expect(screen.getByTestId("article-content-mode-manual").textContent).toBe("手动编辑");
    expect(screen.queryByText("template")).toBeNull();
    expect(screen.queryByText("manual")).toBeNull();
  });

  it("勾选行驱动已选计数", () => {
    render(<ArticleList rows={[DRAFT_ROW, PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    expect(screen.getByText("已选择 0")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(`选择 ${DRAFT_ROW.title}`));
    expect(screen.getByText("已选择 1")).toBeTruthy();
  });

  /**
   * Fix 5 (Opus review of C-21/22/23): the toolbar's single "已选择 N" count
   * used to render as "已选择 N / 50" — a denominator that only ever named
   * the re-generate cap, sitting above two buttons with two different caps
   * (50 re-generate, 200 publish). Each cap now sits next to its own button
   * instead of the shared count.
   */
  it("批量再生成按钮旁标注「/ 50」，批量发布按钮旁标注「/ 200」，而不是挂在已选计数上", () => {
    render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    expect(screen.getByText("已选择 0")).toBeTruthy();
    expect(screen.queryByText("已选择 0 / 50")).toBeNull();
    const regenerateButton = screen.getByText("批量再生成");
    expect(regenerateButton.parentElement?.textContent).toContain("/ 50");
    const publishButton = screen.getByTestId("articles-batch-publish");
    expect(publishButton.parentElement?.textContent).toContain("/ 200");
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

  /**
   * C-26 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-26):
   * "批量再生成按钮旁增加一行提示：当选中项里含有'手动编辑'的文章时，明确
   * 提示'其中 N 篇为手动编辑，再生成会覆盖运营正文'". Three cases: none
   * selected are manual (no warning), some are (warning with the exact
   * count), and the count only reflects *selected* manual rows, not every
   * manual row in the list.
   */
  it("未选中手动编辑文章时不展示「含手动编辑」提示", () => {
    render(
      <ArticleList
        rows={[{ ...DRAFT_ROW, contentMode: "template" }]}
        canWrite
        publicOrigin={PUBLIC_ORIGIN}
      />,
    );
    fireEvent.click(screen.getByLabelText(`选择 ${DRAFT_ROW.title}`));
    expect(screen.queryByTestId("articles-batch-regenerate-manual-warning")).toBeNull();
  });

  it("选中的文章含手动编辑时展示提示，并给出精确计数", () => {
    const manualRow = { ...DRAFT_ROW, id: "manual-row", title: "Manual Row", contentMode: "manual" };
    const templateRow = { ...PUBLISHED_ROW, contentMode: "template" };
    render(<ArticleList rows={[manualRow, templateRow]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    fireEvent.click(screen.getByLabelText(`选择 ${manualRow.title}`));
    expect(screen.getByTestId("articles-batch-regenerate-manual-warning").textContent).toBe(
      "其中 1 篇为手动编辑，再生成会覆盖运营正文",
    );
    // 再勾选一个非手动编辑的行——计数只反映已选中的 manual 行，不随之增长。
    fireEvent.click(screen.getByLabelText(`选择 ${templateRow.title}`));
    expect(screen.getByTestId("articles-batch-regenerate-manual-warning").textContent).toBe(
      "其中 1 篇为手动编辑，再生成会覆盖运营正文",
    );
  });

  it("contentMode 缺字段时回退为 template，不计入「含手动编辑」提示", () => {
    render(<ArticleList rows={[{ ...DRAFT_ROW, contentMode: undefined }]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    fireEvent.click(screen.getByLabelText(`选择 ${DRAFT_ROW.title}`));
    expect(screen.queryByTestId("articles-batch-regenerate-manual-warning")).toBeNull();
  });

  it("canWrite=false 时批量按钮禁用", () => {
    render(<ArticleList rows={[DRAFT_ROW]} canWrite={false} publicOrigin={PUBLIC_ORIGIN} />);
    expect((screen.getByText("批量再生成") as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * C-28 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-28):
   * "the C-27 article_not_regenerable outcome surfaces as a disabled
   * 再生成". Single-row button + batch warning, same shape as the
   * manual-edit warning tests above.
   */
  describe("再生成对博客文章禁用（C-28）", () => {
    it("博客行（articleType=blog_article）的单行再生成按钮被禁用并带提示", () => {
      const blogRow = { ...DRAFT_ROW, id: "blog-row", title: "Blog Row", articleType: "blog_article", novel: undefined };
      render(<ArticleList rows={[blogRow]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      const button = screen.getByTestId(`article-regenerate-${blogRow.id}`) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("博客文章没有绑定模板，不支持再生成");
    });

    it("小说文章行（articleType=novel_article）的单行再生成按钮不受影响", () => {
      render(<ArticleList rows={[{ ...DRAFT_ROW, articleType: "novel_article" }]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      const button = screen.getByTestId(`article-regenerate-${DRAFT_ROW.id}`) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.title).toBe("");
    });

    it("articleType 缺字段时回退为 novel_article，再生成按钮不禁用", () => {
      render(<ArticleList rows={[{ ...DRAFT_ROW, articleType: undefined }]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      const button = screen.getByTestId(`article-regenerate-${DRAFT_ROW.id}`) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });

    it("选中含博客文章的行时，批量再生成按钮旁展示提示，计数只反映已选中的博客行", () => {
      const blogRow = { ...DRAFT_ROW, id: "blog-row", title: "Blog Row", articleType: "blog_article" };
      const novelRow = { ...PUBLISHED_ROW, articleType: "novel_article" };
      render(<ArticleList rows={[blogRow, novelRow]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      expect(screen.queryByTestId("articles-batch-regenerate-blog-warning")).toBeNull();
      fireEvent.click(screen.getByLabelText(`选择 ${blogRow.title}`));
      expect(screen.getByTestId("articles-batch-regenerate-blog-warning").textContent).toBe(
        "其中 1 篇为博客文章，没有绑定模板，再生成会失败",
      );
      fireEvent.click(screen.getByLabelText(`选择 ${novelRow.title}`));
      expect(screen.getByTestId("articles-batch-regenerate-blog-warning").textContent).toBe(
        "其中 1 篇为博客文章，没有绑定模板，再生成会失败",
      );
    });
  });

  it("表头「选择当前页」全选后已选择 2，再点一次归零（C-17）", () => {
    render(<ArticleList rows={[DRAFT_ROW, PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    const header = screen.getByLabelText("选择当前页");
    fireEvent.click(header);
    expect(screen.getByText("已选择 2")).toBeTruthy();
    fireEvent.click(header);
    expect(screen.getByText("已选择 0")).toBeTruthy();
  });

  it("只勾一行时表头呈半选态；勾满后为满选态（C-17，对齐 novels-batch-publish 同名用例）", () => {
    render(<ArticleList rows={[DRAFT_ROW, PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    const header = screen.getByLabelText("选择当前页") as HTMLInputElement;
    fireEvent.click(screen.getByLabelText(`选择 ${DRAFT_ROW.title}`));
    expect(header.checked).toBe(false);
    expect(header.indeterminate).toBe(true);
    fireEvent.click(screen.getByLabelText(`选择 ${PUBLISHED_ROW.title}`));
    expect(header.checked).toBe(true);
    expect(header.indeterminate).toBe(false);
  });

  /**
   * 低危清扫第 1 批 · item B：半选态曾经读 `selected.size > 0 &&
   * !allSelected`——CPS `dramas-list-client.tsx:65-66` 的写法，在那个不分页
   * 的列表里成立（`selected` 不可能装着 `dramas` 之外的 id）。`/articles`
   * 是服务端分页（`ArticleList` 本身不在 rows 变化时清空 `selected`，与
   * `articles-client.tsx` 的 `filterKey` 重置不同），所以选择集完全可能带着
   * "上一页选过、这一页已经看不到"的 id。用 `rerender` 换一批 rows 模拟翻页
   * ——不清空选择、也不给组件换 key，这正是当前代码的真实使用形态：
   * `../page.tsx` 按查询参数分页时不会把 `<ArticleList key=... />` 重新挂载。
   */
  it("翻页后残留的跨页选择不应让新一页的表头误报半选态", () => {
    const { rerender } = render(
      <ArticleList rows={[DRAFT_ROW, PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />,
    );
    fireEvent.click(screen.getByLabelText(`选择 ${DRAFT_ROW.title}`));
    expect(screen.getByText("已选择 1")).toBeTruthy();

    // 翻到不包含 DRAFT_ROW 的下一页，选择状态原样保留（组件未重新挂载）。
    rerender(<ArticleList rows={[UNPUBLISHED_ROW, TAKEDOWN_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    const header = screen.getByLabelText("选择当前页") as HTMLInputElement;
    expect(header.checked).toBe(false);
    expect(header.indeterminate).toBe(false);
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

    it("Server Action 返回 ok:false 且 code 是不透明的 *_failed fallback 时，仍展示原始错误码（没有对应译文可映射）", async () => {
      listActions.publishArticleAction.mockResolvedValue({ ok: false, code: "article_publish_failed" });
      render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      fireEvent.click(screen.getByTestId(`article-publish-${DRAFT_ROW.id}`));
      await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("article_publish_failed"));
    });

    /**
     * Fix 1 (Opus review of C-21/22/23, MUST): this call site used to render
     * `发布失败：${result.code}` verbatim — a `PublishLifecycleError.code`
     * (e.g. `novel_not_found`) is operator-meaningless on its own. It must
     * now go through `describePublishLifecycleError`
     * (`../../novels/_lib/publish-outcome-copy.ts`), the same function the
     * `/novels` detail page's publish button already uses.
     */
    it("Server Action 返回 PublishLifecycleError 的 code 时，展示中文译文而不是裸标识符", async () => {
      listActions.publishArticleAction.mockResolvedValue({ ok: false, code: "novel_not_found" });
      render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      fireEvent.click(screen.getByTestId(`article-publish-${DRAFT_ROW.id}`));
      await vi.waitFor(() =>
        expect(screen.getByRole("status").textContent).toContain("该书目不存在或已被删除，请刷新列表后重试。"),
      );
      expect(screen.queryByText(/novel_not_found/)).toBeNull();
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

    /**
     * Fix 3 (Opus review of C-21/22/23, SHOULD): mirrors the novel-detail
     * lifecycle panel's own reason-length guard
     * (`../../novels/_components/publish-lifecycle-panel.tsx`'s
     * `runRightsTransition`, backed by `../../novels/_lib/reason-guard.ts`'s
     * `validateReason`). Before this fix, an over-1000-char reason sailed
     * through to `withdrawArticleAction`, where `withdrawNovel`'s own
     * `trimmedReason` throws a bare `Error` that collapses to the opaque
     * `article_withdraw_failed` fallback (`tests/ui/articles-actions.test.ts`
     * pins that collapse at the Server Action layer) — this test pins that
     * the client now catches it first with a readable message and never
     * calls the action at all.
     */
    it("下线原因超过 1000 字时不提交，展示清晰的长度提示而不是走到通用 article_withdraw_failed", async () => {
      render(<ArticleList rows={[PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId(`article-withdraw-${PUBLISHED_ROW.id}`));
      });
      await waitFor(() => expect(dialog()?.open).toBe(true));
      fireEvent.change(screen.getByLabelText("下线原因"), { target: { value: "字".repeat(1001) } });
      await act(async () => {
        fireEvent.click(within(dialog()!).getByRole("button", { name: "下线" }));
      });
      expect(listActions.withdrawArticleAction).not.toHaveBeenCalled();
      expect(dialog()?.open).toBe(true);
      expect(screen.getByTestId("article-withdraw-reason-error").textContent).toContain("1000 字以内");
      expect(screen.queryByText(/article_withdraw_failed/)).toBeNull();
    });

    /**
     * Fix 1 (Opus review of C-21/22/23, MUST): the "row-level code" case —
     * `withdrawNovel` really can throw `PublishLifecycleError`
     * (`novel_not_currently_published`, when the novel's status changed out
     * from under this row between page load and click), unlike the row-level
     * publish button above whose lifecycle-error path is currently
     * unreachable in practice. Same mapping requirement either way: the
     * operator must see the Chinese copy, not the identifier.
     */
    it("withdrawArticleAction 返回 PublishLifecycleError 的 code 时，展示中文译文而不是裸标识符", async () => {
      listActions.withdrawArticleAction.mockResolvedValue({ ok: false, code: "novel_not_currently_published" });
      render(<ArticleList rows={[PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId(`article-withdraw-${PUBLISHED_ROW.id}`));
      });
      await waitFor(() => expect(dialog()?.open).toBe(true));
      fireEvent.change(screen.getByLabelText("下线原因"), { target: { value: "运营决定临时下线" } });
      await act(async () => {
        fireEvent.click(within(dialog()!).getByRole("button", { name: "下线" }));
      });
      await vi.waitFor(() =>
        expect(screen.getByRole("status").textContent).toContain(
          "该书目当前不是「已发布」状态，无法执行下架。",
        ),
      );
      expect(screen.queryByText(/novel_not_currently_published/)).toBeNull();
    });

    /**
     * Fix (Owner-approved 窄范围修复 lane, 2026-09-11 —
     * feedback_delegate_to_sonnet.md 施工工单): before this fix, `await
     * withdrawArticleAction(...)` in `confirmWithdraw` sat outside any
     * try/catch while `onConfirm` fires it as `void confirmWithdraw()` — a
     * *rejected* promise (observed live as a stale Next.js build's "Failed
     * to find Server Action" after a deploy shipped a new bundle) skipped
     * every line after the `await`, including `setWithdrawBusy(false)`,
     * leaving `pending={withdrawBusy}` stuck `true` and the confirm button
     * permanently reading "处理中…", disabled, with no error surfaced and no
     * way to retry short of a full page reload. Pins the fix at the
     * component level (not just "the promise resolved"): the button becomes
     * clickable again and shows its normal "下线" label, a readable
     * refresh-prompting message appears, the dialog is deliberately left
     * open (so the reason the operator typed isn't lost and they can just
     * press the button again after refreshing), and no premature
     * `router.refresh()` fires.
     */
    it("withdrawArticleAction 因 stale bundle 而 reject（Failed to find Server Action）时，按钮恢复可点击并展示刷新提示，而不是永久卡在「处理中」", async () => {
      listActions.withdrawArticleAction.mockRejectedValue(
        new Error('Failed to find Server Action "abc123def456". This request might be from an older or newer deployment.'),
      );
      render(<ArticleList rows={[PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId(`article-withdraw-${PUBLISHED_ROW.id}`));
      });
      await waitFor(() => expect(dialog()?.open).toBe(true));
      fireEvent.change(screen.getByLabelText("下线原因"), { target: { value: "运营决定临时下线" } });
      const confirmButton = () => within(dialog()!).getByRole("button", { name: /^(下线|处理中…)$/ });
      await act(async () => {
        fireEvent.click(confirmButton());
      });
      await waitFor(() => expect((confirmButton() as HTMLButtonElement).disabled).toBe(false));
      expect(confirmButton().textContent).toBe("下线");
      expect(dialog()?.open).toBe(true);
      await vi.waitFor(() =>
        expect(screen.getByRole("status").textContent).toContain("撤回请求未完成（页面版本已过期），请刷新页面后重试"),
      );
      expect(routerRefresh).not.toHaveBeenCalled();
    });

    it("withdrawArticleAction 因普通网络错误 reject 时，同样恢复可点击并展示（非 stale-bundle 措辞的）刷新提示", async () => {
      listActions.withdrawArticleAction.mockRejectedValue(new Error("Network request failed"));
      render(<ArticleList rows={[PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId(`article-withdraw-${PUBLISHED_ROW.id}`));
      });
      await waitFor(() => expect(dialog()?.open).toBe(true));
      fireEvent.change(screen.getByLabelText("下线原因"), { target: { value: "运营决定临时下线" } });
      const confirmButton = () => within(dialog()!).getByRole("button", { name: /^(下线|处理中…)$/ });
      await act(async () => {
        fireEvent.click(confirmButton());
      });
      await waitFor(() => expect((confirmButton() as HTMLButtonElement).disabled).toBe(false));
      await vi.waitFor(() =>
        expect(screen.getByRole("status").textContent).toContain("撤回请求未完成（网络或页面版本已过期），请刷新页面后重试"),
      );
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
      expect(screen.getByText("已选择 0")).toBeTruthy();
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

    /**
     * Fix 1 (Opus review of C-21/22/23, MUST): the required `batch_too_large`
     * case — `publishArticlesBatchAsAdmin` really does throw
     * `PublishLifecycleError("batch_too_large", …)` when the selection
     * exceeds `MAX_BATCH_PUBLISH_SELECTION`, and this call site used to
     * render `批量发布失败：batch_too_large` verbatim.
     */
    it("批量发布返回 batch_too_large 时展示中文译文而不是裸标识符", async () => {
      listActions.publishArticlesBatchAction.mockResolvedValue({ ok: false, code: "batch_too_large" });
      render(<ArticleList rows={[DRAFT_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      fireEvent.click(screen.getByLabelText(`选择 ${DRAFT_ROW.title}`));
      fireEvent.click(screen.getByTestId("articles-batch-publish"));
      await vi.waitFor(() =>
        expect(screen.getByRole("status").textContent).toContain(
          "本次选择的书目数超过批量发布上限（200 部），请分批提交。",
        ),
      );
      expect(screen.queryByText(/batch_too_large/)).toBeNull();
    });

    /**
     * Fix 2 (Opus review of C-21/22/23, SHOULD): pins the batch-publish cap
     * guard that already existed in the component (`overPublishCap`) but had
     * no test of its own — mirrors `tests/ui/novels-batch-publish.test.tsx`'s
     * "选择超过上限时展示提示并禁用提交按钮". Selects via the header "选择当
     * 前页" checkbox (one click, `toggleAll`) rather than clicking all 201
     * row checkboxes individually — same end state (`selected.size`-driven),
     * far cheaper under jsdom.
     */
    it("勾选超过上限（200 篇）时展示提示并禁用批量发布按钮", () => {
      const many = Array.from({ length: 201 }, (_, index) => ({
        ...DRAFT_ROW,
        id: `over-cap-${index}`,
        title: `Over Cap Article ${index}`,
      }));
      render(<ArticleList rows={many} canWrite publicOrigin={PUBLIC_ORIGIN} />);
      fireEvent.click(screen.getByLabelText("选择当前页"));
      expect(screen.getByText("已选择 201")).toBeTruthy();
      expect(screen.getByText(/超过批量发布上限（200 篇），请减少选择后再提交/)).toBeTruthy();
      const submit = screen.getByTestId("articles-batch-publish") as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
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
  seoVisibility: "public",
  // C-26: required fields on `ArticleEditor`'s `article` prop (see that
  // component's own header comment on why these are read-only display, not
  // form fields).
  articleType: "novel_article",
  contentMode: "template",
  updatedAt: "2026-09-05T02:00:00.000Z",
};

describe("ArticleEditor · 编辑与预览", () => {
  it("渲染 slug/shortId 只读展示与正文预览", () => {
    render(<ArticleEditor article={ARTICLE} canWrite />);
    expect(screen.getByText(/slug: some-slug/)).toBeTruthy();
    expect(screen.getByText(/shortId: AbCdEf12/)).toBeTruthy();
    expect(screen.getByText("Body content")).toBeTruthy();
  });

  /**
   * C-26 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-26):
   * 类型/内容模式 render as read-only text (CPS-wording Chinese labels, not
   * raw codes) — no form control, no `name` attribute, nothing that could
   * feed `updateArticleAction`'s patch. This is the plan's own "不移植 CPS
   * 的内容模式与模板选择器的联动" exception in the UI: these are
   * system-observed facts, not operator-editable fields.
   */
  it("类型/内容模式以只读中文文案展示，不是可编辑控件", () => {
    render(<ArticleEditor article={{ ...ARTICLE, articleType: "blog_article", contentMode: "manual" }} canWrite />);
    const line = screen.getByTestId("article-editor-type-content-mode");
    expect(line.textContent).toBe("类型: 博客文章 · 内容模式: 手动编辑");
    expect(line.tagName).toBe("P");
    expect(line.querySelector("select, input, button")).toBeNull();
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

  /**
   * C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
   * "文章编辑页 SEO 区块新增三选一单选…默认值来自数据行" — pins that all three
   * CPS-wording pills render and that the row's own `seoVisibility` (not a
   * hardcoded default) drives which one starts selected.
   */
  it("SEO 可见性三选一渲染三颗药丸，默认选中值来自数据行", () => {
    render(<ArticleEditor article={{ ...ARTICLE, seoVisibility: "seo_only" }} canWrite />);
    const publicPill = screen.getByTestId("article-seo-visibility-option-public");
    const seoOnlyPill = screen.getByTestId("article-seo-visibility-option-seo_only");
    const hiddenPill = screen.getByTestId("article-seo-visibility-option-hidden");
    expect(publicPill.textContent).toBe("公开收录");
    expect(seoOnlyPill.textContent).toBe("仅 SEO（不展示）");
    expect(hiddenPill.textContent).toBe("隐藏（noindex）");
    expect(seoOnlyPill.getAttribute("aria-checked")).toBe("true");
    expect(publicPill.getAttribute("aria-checked")).toBe("false");
    expect(hiddenPill.getAttribute("aria-checked")).toBe("false");
  });

  /**
   * C-25: the row-level "行内三选一小下拉" from the plan's discussion is
   * explicitly OUT per this round's binding Owner decision (no row toggle in
   * the list) — the editor form's three-pill selector is the *only* write
   * surface, and it must reach `updateArticleAction` (the exact same Server
   * Action `_actions.ts` wires for every other field on this form) rather
   * than a second endpoint, per the analysis doc's "同一个 action id" framing
   * even though this round never builds the row-level control at all.
   */
  it("切换 SEO 可见性药丸后保存，seoVisibility 随其它字段一起进入 updateArticleAction 的 patch", async () => {
    editorActions.updateArticleAction.mockResolvedValue({ ok: true });
    render(<ArticleEditor article={{ ...ARTICLE, seoVisibility: "public" }} canWrite />);
    fireEvent.click(screen.getByTestId("article-seo-visibility-option-hidden"));
    fireEvent.click(screen.getByText("保存"));
    await vi.waitFor(() => expect(editorActions.updateArticleAction).toHaveBeenCalledTimes(1));
    expect(editorActions.updateArticleAction.mock.calls[0]![0]).toMatchObject({
      patch: expect.objectContaining({ seoVisibility: "hidden" }),
    });
  });
});

/**
 * C-28 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-28):
 * "编辑页按文章类型分叉:博客走一套没有模板绑定、没有再生成按钮的编辑器".
 * `ArticleBlogEditor` has no template/regenerate control at all (same as
 * `ArticleEditor`, which never had one either — see that component's own
 * header) — what this block actually pins is the two blog-only fields
 * (`coverUrl`/`metaKeywords`) round-tripping through the same
 * `updateArticleAction` write口, and the type/content-mode line reading
 * real values rather than a hardcoded "博客文章" string.
 */
const BLOG_ARTICLE = {
  id: "blog-article-1",
  title: "Blog Title",
  summary: "Blog summary",
  body: "<p>Blog body</p>",
  seoMetadata: {
    metaTitle: "Blog meta title",
    metaDescription: "Blog meta description",
    metaKeywords: "keyword-a, keyword-b",
    coverUrl: "https://example.com/cover.jpg",
  },
  slug: "blog-slug",
  publicPageShortId: "BlgShrt1",
  seoVisibility: "public",
  articleType: "blog_article",
  contentMode: "manual",
  updatedAt: "2026-09-05T02:00:00.000Z",
};

describe("ArticleBlogEditor · 博客编辑（C-28）", () => {
  it("渲染封面 URL 与 SEO 关键词字段，预填自 seoMetadata", () => {
    render(<ArticleBlogEditor article={BLOG_ARTICLE} canWrite />);
    expect(screen.getByDisplayValue("https://example.com/cover.jpg")).toBeTruthy();
    expect(screen.getByDisplayValue("keyword-a, keyword-b")).toBeTruthy();
  });

  it("类型/内容模式读取真实字段值，而不是写死「博客文章」", () => {
    render(<ArticleBlogEditor article={BLOG_ARTICLE} canWrite />);
    const line = screen.getByTestId("article-blog-editor-type-line");
    expect(line.textContent).toBe("类型: 博客文章 · 内容模式: 手动编辑");
  });

  it("没有小说/推广链接相关字段或书目跳转链接", () => {
    render(<ArticleBlogEditor article={BLOG_ARTICLE} canWrite />);
    expect(screen.queryByText(/查看所属书目/)).toBeNull();
    expect(screen.queryByText(/推广链接/)).toBeNull();
    expect(screen.queryByText(/模板/)).toBeNull();
  });

  it("保存时把 coverUrl/metaKeywords 与其它字段一起送入 updateArticleAction 的 patch（避免被整体替换的 seoMetadata 静默清空）", async () => {
    editorActions.updateArticleAction.mockResolvedValue({ ok: true });
    render(<ArticleBlogEditor article={BLOG_ARTICLE} canWrite />);
    fireEvent.click(screen.getByText("保存"));
    await vi.waitFor(() => expect(editorActions.updateArticleAction).toHaveBeenCalledTimes(1));
    expect(editorActions.updateArticleAction.mock.calls[0]![0]).toMatchObject({
      articleId: BLOG_ARTICLE.id,
      expectedUpdatedAt: BLOG_ARTICLE.updatedAt,
      patch: expect.objectContaining({
        coverUrl: "https://example.com/cover.jpg",
        metaKeywords: "keyword-a, keyword-b",
      }),
    });
  });

  it("canWrite=false 时保存按钮禁用", () => {
    render(<ArticleBlogEditor article={BLOG_ARTICLE} canWrite={false} />);
    expect((screen.getByText("保存") as HTMLButtonElement).disabled).toBe(true);
  });
});

const LOCALES = ["en", "fr"];
const CATEGORY_OPTIONS = [
  { id: "11111111-1111-4111-8111-111111111111", label: "言情" },
  { id: "22222222-2222-4222-8222-222222222222", label: "romance-no-zh" },
];
// L10N P5: `locale: null` was a stale second-template fixture predating
// L10N P3's `ArticleTemplate.locale` NOT NULL migration — real rows can no
// longer have a null locale (`article-filters.tsx`'s own
// `ArticleTemplateOption.locale` is `string`, not `string | null`, since
// that migration). `"fr"` doubles as exercising a second real locale
// already present in `LOCALES` above.
const TEMPLATE_OPTIONS = [
  { id: "33333333-3333-4333-8333-333333333333", templateKey: "tpl-a", locale: "en", version: 2 },
  { id: "44444444-4444-4444-8444-444444444444", templateKey: "tpl-b", locale: "fr", version: 1 },
];

describe("ArticleFilters · C-19 filters", () => {
  it("字段 name 属性与 page.tsx 读取的 query-string key 一致（含新增的 search/canonicalTagId/seoVisibility/articleType/contentMode）", () => {
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
    expect((screen.getByLabelText("SEO 可见性") as HTMLSelectElement).name).toBe("seoVisibility");
    expect((screen.getByLabelText("类型") as HTMLSelectElement).name).toBe("articleType");
    expect((screen.getByLabelText("内容模式") as HTMLSelectElement).name).toBe("contentMode");
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
          seoVisibility: "seo_only",
          articleType: "blog_article",
          contentMode: "manual",
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
    expect((screen.getByLabelText("SEO 可见性") as HTMLSelectElement).value).toBe("seo_only");
    expect((screen.getByLabelText("类型") as HTMLSelectElement).value).toBe("blog_article");
    expect((screen.getByLabelText("内容模式") as HTMLSelectElement).value).toBe("manual");
  });

  /**
   * C-25: "选项文案照抄 CPS：公开收录 / 仅 SEO（不展示）/ 隐藏（noindex）" — the
   * filter dropdown's option labels are the longer CPS wording, distinct
   * from the table badge's shorter "公开/仅 SEO/隐藏" (see
   * `article-seo-visibility-badge.tsx`'s own test).
   */
  it("SEO 可见性下拉选项文案照抄 CPS（公开收录 / 仅 SEO（不展示）/ 隐藏（noindex））", () => {
    render(
      <ArticleFilters values={{}} locales={LOCALES} categoryOptions={CATEGORY_OPTIONS} templateOptions={TEMPLATE_OPTIONS} />,
    );
    const select = screen.getByLabelText("SEO 可见性") as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((option) => option.textContent);
    expect(optionLabels).toEqual(["全部可见性", "公开收录", "仅 SEO（不展示）", "隐藏（noindex）"]);
  });

  /**
   * C-26 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-26):
   * "选项文案照抄 CPS：剧集文章→小说文章（唯一的改名...）/ 博客文章 / 榜单
   * Listicle / 指南 Guide；手动编辑 / 使用模板". Labels are CPS's own strings
   * verbatim (`ARTICLE_TYPE_OPTIONS`/`CONTENT_MODE_OPTIONS` in
   * `article-v2-contract.ts`), with the one rename the plan calls out.
   */
  it("类型下拉选项文案照抄 CPS（含 novel_article 改名为「小说文章」）", () => {
    render(
      <ArticleFilters values={{}} locales={LOCALES} categoryOptions={CATEGORY_OPTIONS} templateOptions={TEMPLATE_OPTIONS} />,
    );
    const select = screen.getByLabelText("类型") as HTMLSelectElement;
    const options = Array.from(select.options);
    expect(options.map((option) => option.textContent)).toEqual([
      "全部类型",
      "小说文章",
      "博客文章",
      "榜单 / Listicle",
      "指南 / Guide",
    ]);
    expect(options.map((option) => option.value)).toEqual(["", "novel_article", "blog_article", "listicle", "guide"]);
  });

  it("内容模式下拉选项文案照抄 CPS（手动编辑 / 使用模板）", () => {
    render(
      <ArticleFilters values={{}} locales={LOCALES} categoryOptions={CATEGORY_OPTIONS} templateOptions={TEMPLATE_OPTIONS} />,
    );
    const select = screen.getByLabelText("内容模式") as HTMLSelectElement;
    const options = Array.from(select.options);
    expect(options.map((option) => option.textContent)).toEqual(["全部内容模式", "手动编辑", "使用模板"]);
    expect(options.map((option) => option.value)).toEqual(["", "manual", "template"]);
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
