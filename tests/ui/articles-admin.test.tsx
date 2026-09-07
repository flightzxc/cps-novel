import "./setup-cleanup";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
};

const PUBLISHED_ROW: ArticleListRow = {
  ...DRAFT_ROW,
  id: "article-2",
  title: "Published Article",
  status: "published",
  updatedAt: "2026-09-05T02:30:00.000Z",
};

beforeEach(() => {
  listActions.regenerateArticleAction.mockReset();
  listActions.regenerateArticlesBatchAction.mockReset();
  editorActions.updateArticleAction.mockReset();
  routerRefresh.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ArticleList · 列表与批量", () => {
  it("渲染标题/状态/模板，未发布文章不出现公开页链接，已发布出现", () => {
    render(<ArticleList rows={[DRAFT_ROW, PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    expect(screen.getByText("Draft Article")).toBeTruthy();
    expect(screen.getByText("Published Article")).toBeTruthy();
    expect(screen.getAllByText("公开页")).toHaveLength(1);
  });

  /**
   * RC-9 regression: the console and the public site are different origins,
   * and the admin origin 404s every public content path. A site-relative href
   * would resolve against the admin host — exactly the 404 this pins against.
   */
  it("公开页链接指向 SITE_URL 公开域，而非当前后台域（RC-9）", () => {
    render(<ArticleList rows={[DRAFT_ROW, PUBLISHED_ROW]} canWrite publicOrigin={PUBLIC_ORIGIN} />);
    const link = screen.getByText("公开页") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      `${PUBLIC_ORIGIN}/novel/${PUBLISHED_ROW.slug}-p${PUBLISHED_ROW.publicPageShortId}`,
    );
  });

  it("publicOrigin 缺失时退回站内相对路径，不渲染 null 前缀", () => {
    render(<ArticleList rows={[PUBLISHED_ROW]} canWrite publicOrigin={null} />);
    const link = screen.getByText("公开页") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      `/novel/${PUBLISHED_ROW.slug}-p${PUBLISHED_ROW.publicPageShortId}`,
    );
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
