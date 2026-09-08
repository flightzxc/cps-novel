import "./setup-cleanup";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * C-28 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-28):
 * "新建博客" entry, page-level flag gating, and the create form's field
 * set. Source-text assertions for the async Server Components (same
 * mechanism `articles-admin.test.tsx`'s C-22/C-23 blocks already use — this
 * repo has no render-based unit test precedent for `(admin)/**\/page.tsx`),
 * plain `resolveAdminPage`/registry calls for the route-registry checks the
 * plan explicitly asks to "显式复核一次" rather than assume, and a real
 * `@testing-library/react` render for the client form component.
 */
const root = resolve(import.meta.dirname, "../..");

describe("ArticlesPage 「新建博客」入口按钮（C-28，源码级断言）", () => {
  const source = readFileSync(resolve(root, "src/app/(admin)/articles/page.tsx"), "utf8");
  // Anchored on the `data-testid`, not the bare label text — "新建博客" also
  // appears inside this block's own doc comment (explaining the ADAPT),
  // which would otherwise be matched first by a plain `indexOf`.
  const anchorIdx = source.indexOf('data-testid="articles-new-blog-entry"');

  it("入口按钮存在，指向 /articles/new-blog，文案为「新建博客」", () => {
    expect(anchorIdx).toBeGreaterThan(-1);
    const before = source.slice(0, anchorIdx);
    const hrefMatch = before.match(/href="([^"]*)"(?!.*href=")/s);
    expect(hrefMatch?.[1]).toBe("/articles/new-blog");
    const after = source.slice(anchorIdx, anchorIdx + 200);
    expect(after).toContain("新建博客");
  });

  it("按钮由 isArticleBlogEnabled 门控渲染，不是无条件展示", () => {
    // The nearest preceding `{...&& (` conditional before the anchor must be
    // the flag check, not some unrelated `granted`/`canWrite` gate.
    const guardIdx = source.lastIndexOf("isArticleBlogEnabled(process.env) &&");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(anchorIdx);
    const between = source.slice(guardIdx, anchorIdx);
    // Nothing else that looks like a second, different conditional sits
    // between the guard and the button — i.e. this really is the guard
    // wrapping this exact button, not an unrelated earlier one in the file.
    expect(between).not.toMatch(/\}\s*:\s*|\{granted|\{canWrite/);
  });
});

describe("NewBlogArticlePage 路由保护与门控（C-28，源码级断言）", () => {
  const source = readFileSync(
    resolve(root, "src/app/(admin)/articles/new-blog/page.tsx"),
    "utf8",
  );

  it("FEATURE_ARTICLE_BLOG 关闭时调用 notFound()（kill switch）", () => {
    expect(source).toMatch(/if\s*\(!isArticleBlogEnabled\(process\.env\)\)\s*notFound\(\);/);
  });

  it("声明 force-dynamic，避免 kill switch 在构建期被固化", () => {
    expect(source).toContain('export const dynamic = "force-dynamic";');
  });

  it("页面级能力校验为 content:publish（新建即写入，不是只读预览）", () => {
    expect(source).toContain('requireContentPage("/articles/new-blog", "content:publish")');
  });
});

describe("/articles/new-blog 路由保护：真实前缀匹配复核（C-28 风险条目）", () => {
  it("resolveAdminPage(\"/articles/new-blog\") 解析到已注册的 /articles 根，而不是裸奔", async () => {
    const { resolveAdminPage } = await import("@/server/auth/registry");
    expect(resolveAdminPage("/articles/new-blog")).toBe("/articles");
  });
});

describe("admin.article.create_blog 已在注册表登记（C-28）", () => {
  it("能力沿用 content:publish，与 admin.article.update 同级", async () => {
    const { ADMIN_ARTICLE_ACTIONS } = await import("@/app/api/admin/_lib/registry");
    const entry = ADMIN_ARTICLE_ACTIONS.find((action) => action.id === "admin.article.create_blog");
    expect(entry).toBeDefined();
    expect(entry?.capability).toBe("content:publish");
    expect(entry?.mutation).toBe(true);
  });
});

describe("ArticleEditPage 编辑器分叉（C-28，源码级断言）", () => {
  const source = readFileSync(
    resolve(root, "src/app/(admin)/articles/[articleId]/page.tsx"),
    "utf8",
  );

  it("按 article.novel === null 分叉到 ArticleBlogEditor / ArticleEditor", () => {
    expect(source).toContain("article.novel === null");
    expect(source).toContain("<ArticleBlogEditor");
    expect(source).toContain("<ArticleEditor");
  });
});

const createBlogArticleAction = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());

vi.mock("@/app/(admin)/articles/_actions", () => ({ createBlogArticleAction }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));

describe("BlogCreateForm · 字段与提交（C-28）", () => {
  beforeEach(() => {
    createBlogArticleAction.mockReset();
    routerPush.mockReset();
  });

  it("字段集只有 语种/标题/Slug/封面/SEO三件套/正文 —— 没有书目选择器、没有模板选择器", async () => {
    const { BlogCreateForm } = await import(
      "@/app/(admin)/articles/new-blog/_components/blog-create-form"
    );
    render(<BlogCreateForm />);
    expect(screen.getByTestId("blog-create-locale")).toBeTruthy();
    expect(screen.getByTestId("blog-create-title")).toBeTruthy();
    expect(screen.getByTestId("blog-create-slug")).toBeTruthy();
    expect(screen.getByTestId("blog-create-cover-url")).toBeTruthy();
    expect(screen.getByTestId("blog-create-body")).toBeTruthy();
    // No 书目/模板/分类/标签 *selector* anywhere on the page — the banner
    // text itself legitimately says "不需要选择书目或模板" (descriptive, not
    // a control), so this checks control roles/testids, not raw text
    // presence. Exactly one <select> (语种) exists; no combobox/listbox/
    // multi-select carries a 书目/小说/模板/分类/标签-flavored accessible
    // name.
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(screen.queryByTestId(/novel|template|categor|tag/i)).toBeNull();
    for (const forbidden of [/书目/, /关联小说/, /模板/, /分类/, /^标签$/]) {
      expect(screen.queryByRole("combobox", { name: forbidden })).toBeNull();
      expect(screen.queryByRole("listbox", { name: forbidden })).toBeNull();
    }
  });

  it("语种下拉只列出可发布 locale（Owner 2026-09-08 决定：C-29b commit 3），不是全部 15 个 SITE_LOCALES", async () => {
    const { SITE_LOCALES, listPublishableLocales } = await import("@/lib/locale/locale-canonical");
    const { BlogCreateForm } = await import(
      "@/app/(admin)/articles/new-blog/_components/blog-create-form"
    );
    render(<BlogCreateForm />);
    const select = screen.getByTestId("blog-create-locale") as HTMLSelectElement;
    const optionValues = [...select.options].map((option) => option.value);
    expect(optionValues).toEqual(listPublishableLocales());
    // This restriction only says something if it actually narrows the
    // list — guards against `listPublishableLocales()` silently widening
    // back to every registered locale and this assertion staying green for
    // the wrong reason.
    expect(optionValues.length).toBeLessThan(SITE_LOCALES.length);
  });

  it("没有状态或发布时间选择器——创建一律落草稿", async () => {
    const { BlogCreateForm } = await import(
      "@/app/(admin)/articles/new-blog/_components/blog-create-form"
    );
    render(<BlogCreateForm />);
    expect(screen.queryByText("发布时间")).toBeNull();
    expect(screen.queryByRole("combobox", { name: /状态/ })).toBeNull();
  });

  it("提交后调用 createBlogArticleAction，字段原样传递", async () => {
    createBlogArticleAction.mockResolvedValue({
      ok: true,
      data: { outcome: "created", articleId: "new-blog-1", locale: "en", slug: "my-post", publicPageShortId: "abc12345" },
    });
    const { BlogCreateForm } = await import(
      "@/app/(admin)/articles/new-blog/_components/blog-create-form"
    );
    render(<BlogCreateForm />);
    fireEvent.change(screen.getByTestId("blog-create-title"), { target: { value: "My Post" } });
    fireEvent.change(screen.getByTestId("blog-create-slug"), { target: { value: "my-post" } });
    fireEvent.change(screen.getByTestId("blog-create-body"), { target: { value: "<p>Body</p>" } });
    fireEvent.click(screen.getByTestId("blog-create-submit"));
    await vi.waitFor(() => expect(createBlogArticleAction).toHaveBeenCalledTimes(1));
    expect(createBlogArticleAction.mock.calls[0]![0]).toMatchObject({
      locale: "en",
      title: "My Post",
      slug: "my-post",
      body: "<p>Body</p>",
      seoVisibility: "public",
    });
    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith("/articles/new-blog-1"));
  });

  it("slug_conflict outcome 渲染「该语种下这个地址已被占用」，而不是裸唯一冲突码", async () => {
    createBlogArticleAction.mockResolvedValue({
      ok: true,
      data: { outcome: "slug_conflict", locale: "en", slug: "taken" },
    });
    const { BlogCreateForm } = await import(
      "@/app/(admin)/articles/new-blog/_components/blog-create-form"
    );
    render(<BlogCreateForm />);
    fireEvent.change(screen.getByTestId("blog-create-title"), { target: { value: "Title" } });
    fireEvent.change(screen.getByTestId("blog-create-slug"), { target: { value: "taken" } });
    fireEvent.change(screen.getByTestId("blog-create-body"), { target: { value: "<p>Body</p>" } });
    fireEvent.click(screen.getByTestId("blog-create-submit"));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("该语种下这个地址已被占用"));
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("空标题/空正文时客户端拦截提交，不调用 Server Action", async () => {
    const { BlogCreateForm } = await import(
      "@/app/(admin)/articles/new-blog/_components/blog-create-form"
    );
    render(<BlogCreateForm />);
    fireEvent.click(screen.getByTestId("blog-create-submit"));
    expect(screen.getByRole("alert").textContent).toContain("标题不能为空");
    expect(createBlogArticleAction).not.toHaveBeenCalled();
  });

  it("「从标题生成」按钮用 textToSlug 填充 Slug 字段", async () => {
    const { BlogCreateForm } = await import(
      "@/app/(admin)/articles/new-blog/_components/blog-create-form"
    );
    render(<BlogCreateForm />);
    fireEvent.change(screen.getByTestId("blog-create-title"), { target: { value: "Hello World" } });
    // Title change auto-fills slug (untouched field) — same "从标题生成"
    // live-preview behavior CPS's own client-only slugifier gives, but
    // driven by the real server-side algorithm (`@/lib/slug/text-to-slug`).
    expect((screen.getByTestId("blog-create-slug") as HTMLInputElement).value).toBe("hello-world");
  });
});
