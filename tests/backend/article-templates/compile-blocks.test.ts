/**
 * P2-02B: `compile-blocks.ts` behavior tests.
 *
 * This module is the one place a malicious/careless content block could turn into an HTML
 * injection (CPS's `renderContentBlocks` gets this wrong — see the module doc in
 * `compile-blocks.ts`), so these tests cover both directions:
 *   - the compiler itself produces the exact, safe HTML shape for each of the five block
 *     types, escaping literal text while preserving `{field}` / `{if}` / `{endif}` syntax;
 *   - even if a compiled (or hand-crafted) body tried to smuggle a registered field into an
 *     unauthorized HTML context, the existing fail-closed engine gate
 *     (`validateStoredArticleTemplate`, via `html.ts`'s narrow-context contract) still
 *     rejects it — defense in depth, not reliance on the compiler alone.
 */
import { describe, expect, it } from "vitest";

import { validateStoredArticleTemplate } from "@/server/article-templates";
import {
  compileContentBlocks,
  isArticleContentBlock,
  isArticleContentBlockList,
  type ArticleContentBlock,
} from "@/server/article-templates/compile-blocks";
import {
  TEMPLATE_SEO_SCHEMA_VERSION,
  analyzeTemplate,
  buildNovelTemplateValues,
  isTemplateRenderError,
  narrowArticleTemplateSource,
  renderArticleDraft,
} from "@/lib/seo/template";

function validateBody(bodyTemplate: string) {
  return validateStoredArticleTemplate({
    templateKey: "tpl-compile-blocks-test",
    schemaVersion: TEMPLATE_SEO_SCHEMA_VERSION,
    bodyTemplate,
    seoTemplate: { title: "{novel_title}" },
  });
}

describe("isArticleContentBlock / isArticleContentBlockList", () => {
  it("accepts every one of the five registered block types with a string content", () => {
    for (const type of ["heading", "paragraph", "cta", "image", "divider"] as const) {
      expect(isArticleContentBlock({ type, content: "x" })).toBe(true);
    }
  });

  it("rejects unknown type, non-string content, and non-object values", () => {
    expect(isArticleContentBlock({ type: "script", content: "x" })).toBe(false);
    expect(isArticleContentBlock({ type: "heading", content: 42 })).toBe(false);
    expect(isArticleContentBlock({ type: "heading" })).toBe(false);
    expect(isArticleContentBlock(null)).toBe(false);
    expect(isArticleContentBlock("heading")).toBe(false);
    expect(isArticleContentBlock([])).toBe(false);
  });

  it("rejects an empty array — at least one content block is required", () => {
    expect(isArticleContentBlockList([])).toBe(false);
  });

  it("rejects a non-array, and an array containing one bad element", () => {
    expect(isArticleContentBlockList("not-an-array")).toBe(false);
    expect(isArticleContentBlockList([{ type: "heading", content: "ok" }, { type: "bogus", content: "x" }])).toBe(false);
  });

  it("accepts a non-empty array of valid blocks", () => {
    expect(isArticleContentBlockList([{ type: "divider", content: "" }])).toBe(true);
  });
});

describe("compileContentBlocks · 每种区块的编译产物", () => {
  it("heading 编译为 <h2>…</h2>", () => {
    expect(compileContentBlocks([{ type: "heading", content: "{novel_title}" }])).toBe("<h2>{novel_title}</h2>");
  });

  it("paragraph 编译为 <p>…</p>", () => {
    expect(compileContentBlocks([{ type: "paragraph", content: "{novel_description}" }])).toBe(
      "<p>{novel_description}</p>",
    );
  });

  it("cta 编译为 <a href=\"{promo_redirect_url}\">…</a>", () => {
    expect(compileContentBlocks([{ type: "cta", content: "Start Reading" }])).toBe(
      '<a href="{promo_redirect_url}">Start Reading</a>',
    );
  });

  it("image 编译为固定的 {if cover_url}<img src=\"{cover_url}\" alt=\"\" />{endif}，忽略 content 字段", () => {
    const expected = '{if cover_url}<img src="{cover_url}" alt="" />{endif}';
    expect(compileContentBlocks([{ type: "image", content: "this text is ignored" }])).toBe(expected);
    expect(compileContentBlocks([{ type: "image", content: "" }])).toBe(expected);
  });

  it("🔴 image 的 {if} 包裹是承重的：没有它，带图片区块的模板会保存成功却在每一本无封面的小说上生成失败", () => {
    // `cover_url` 在 fields.ts 是 required:false（Novel.coverUrl 可空）。裸引用时
    // analyzeTemplate 会报 unguardedOptionalFields，而 validateStoredArticleTemplate 的
    // 干跑用的是恒有封面的样例值——所以保存期完全看不出问题，问题只在真正生成文章时爆。
    const body = compileContentBlocks([
      { type: "heading", content: "{novel_title}" },
      { type: "image", content: "" },
      { type: "paragraph", content: "{novel_description}" },
    ]);
    expect(analyzeTemplate(body).unguardedOptionalFields).toEqual([]);

    const source = narrowArticleTemplateSource({
      templateKey: "cover-guard",
      schemaVersion: TEMPLATE_SEO_SCHEMA_VERSION,
      bodyTemplate: body,
      seoTemplate: { title: "{novel_title}" },
    });
    expect(source).not.toBeNull();

    const coverless = renderArticleDraft(
      source!,
      buildNovelTemplateValues({
        title: "T",
        description: "D",
        coverUrl: null,
        totalChapterCount: 1,
        previewChapterCount: 1,
        promoRedirectUrl: "/go/x",
      }),
      { templateKey: "cover-guard" },
    );
    // 无封面：整个 <img> 消失，其余区块照常产出——而不是抛 ERR_TEMPLATE_VAR_EMPTY。
    expect(coverless.body).not.toContain("<img");
    expect(coverless.body).toContain("<p>D</p>");

    const withCover = renderArticleDraft(
      source!,
      buildNovelTemplateValues({
        title: "T",
        description: "D",
        coverUrl: "https://example.test/c.jpg",
        totalChapterCount: 1,
        previewChapterCount: 1,
        promoRedirectUrl: "/go/x",
      }),
      { templateKey: "cover-guard" },
    );
    expect(withCover.body).toContain('<img src="https://example.test/c.jpg" alt="" />');
  });

  it("divider 编译为固定的 <hr />，忽略 content 字段", () => {
    expect(compileContentBlocks([{ type: "divider", content: "whatever" }])).toBe("<hr />");
  });

  it("多个区块按顺序拼接", () => {
    const blocks: ArticleContentBlock[] = [
      { type: "heading", content: "{novel_title}" },
      { type: "paragraph", content: "{novel_description}" },
      { type: "divider", content: "" },
      { type: "cta", content: "Read now" },
    ];
    expect(compileContentBlocks(blocks)).toBe(
      ["<h2>{novel_title}</h2>", "<p>{novel_description}</p>", "<hr />", '<a href="{promo_redirect_url}">Read now</a>'].join(
        "\n",
      ),
    );
  });
});

describe("compileContentBlocks · 字面文本转义，占位符原样保留", () => {
  it("字面文本里的 HTML 特殊字符被转义", () => {
    expect(compileContentBlocks([{ type: "paragraph", content: "A & B <script>alert(1)</script>" }])).toBe(
      "<p>A &amp; B &lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("{field} 占位符不被转义，原样保留以便渲染期替换", () => {
    expect(compileContentBlocks([{ type: "paragraph", content: "{novel_title} & {novel_description}" }])).toBe(
      "<p>{novel_title} &amp; {novel_description}</p>",
    );
  });

  it("{if field}...{endif} 语法同样原样保留，字面文本部分照常转义", () => {
    // 注意标签与条件的先后：content 整体就是一个条件块，所以条件被外提到 <p> 外面
    // （见下方"整块条件外提"一节）。本用例关心的是转义与占位符保留：`<b>` 被转义，
    // `{if …}` / `{total_chapter_count}` / `{endif}` 原样保留。
    const content = "{if total_chapter_count}Total: {total_chapter_count} <b>chapters</b>{endif}";
    expect(compileContentBlocks([{ type: "paragraph", content }])).toBe(
      "{if total_chapter_count}<p>Total: {total_chapter_count} &lt;b&gt;chapters&lt;/b&gt;</p>{endif}",
    );
  });

  it("条件只包一部分时，转义与占位符保留的行为完全相同（此时不外提）", () => {
    const content = "Read: {if total_chapter_count}<b>{total_chapter_count}</b>{endif}";
    expect(compileContentBlocks([{ type: "paragraph", content }])).toBe(
      "<p>Read: {if total_chapter_count}&lt;b&gt;{total_chapter_count}&lt;/b&gt;{endif}</p>",
    );
  });

  it("cta 的锚文本同样转义字面文本、保留占位符", () => {
    expect(compileContentBlocks([{ type: "cta", content: 'Click "here" & <win>' }])).toBe(
      '<a href="{promo_redirect_url}">Click &quot;here&quot; &amp; &lt;win&gt;</a>',
    );
  });

  it("单双引号也被转义——即使锚文本/正文不是属性值，仍与 render.ts 的 escapeHtmlText 行为一致", () => {
    expect(compileContentBlocks([{ type: "heading", content: `It's "great"` }])).toBe(
      "<h2>It&#39;s &quot;great&quot;</h2>",
    );
  });
});

describe("整块条件外提：条件包标签，而不是标签包条件", () => {
  it("content 整体是一个条件块时，条件被提到标签外——否则条件不成立的小说会拿到一个空 <p></p>", () => {
    expect(
      compileContentBlocks([
        { type: "paragraph", content: "{if total_chapter_count}Total: {total_chapter_count}{endif}" },
      ]),
    ).toBe("{if total_chapter_count}<p>Total: {total_chapter_count}</p>{endif}");
    // 这正是仓库既有 DEFAULT_ARTICLE_TEMPLATE.body 的写法：
    // `{if total_chapter_count}<p>Total chapters: …</p>{endif}`。
  });

  it("heading 与 cta 同样适用", () => {
    expect(compileContentBlocks([{ type: "heading", content: "{if novel_title}{novel_title}{endif}" }])).toBe(
      "{if novel_title}<h2>{novel_title}</h2>{endif}",
    );
    expect(compileContentBlocks([{ type: "cta", content: "{if novel_title}Read {novel_title}{endif}" }])).toBe(
      '{if novel_title}<a href="{promo_redirect_url}">Read {novel_title}</a>{endif}',
    );
  });

  it("🔴 条件只包住内容的一部分时不外提——外提会把无条件的字面文本一起吞进条件", () => {
    expect(
      compileContentBlocks([{ type: "paragraph", content: "Prefix {if total_chapter_count}Total{endif}" }]),
    ).toBe("<p>Prefix {if total_chapter_count}Total{endif}</p>");
  });

  it("🔴 内容里有两个并列条件时不外提——没有单一条件可提", () => {
    expect(
      compileContentBlocks([
        { type: "paragraph", content: "{if total_chapter_count}A{endif}{if preview_chapter_count}B{endif}" },
      ]),
    ).toBe("<p>{if total_chapter_count}A{endif}{if preview_chapter_count}B{endif}</p>");
  });

  it("最小小说（无封面、无章节计数）渲染出的正文不含任何空标签", () => {
    const body = compileContentBlocks([
      { type: "heading", content: "{novel_title}" },
      { type: "image", content: "" },
      { type: "paragraph", content: "{novel_description}" },
      { type: "paragraph", content: "{if total_chapter_count}Total chapters: {total_chapter_count}{endif}" },
      { type: "cta", content: "Start Reading" },
    ]);
    const source = narrowArticleTemplateSource({
      templateKey: "minimal",
      schemaVersion: TEMPLATE_SEO_SCHEMA_VERSION,
      bodyTemplate: body,
      seoTemplate: { title: "{novel_title}" },
    })!;
    const rendered = renderArticleDraft(
      source,
      buildNovelTemplateValues({
        title: "Minimal Novel",
        description: "Just the required two fields.",
        coverUrl: null,
        totalChapterCount: 0,
        previewChapterCount: 0,
        promoRedirectUrl: "/go/x",
      }),
      { templateKey: "minimal" },
    );
    expect(rendered.body).not.toContain("<p></p>");
    expect(rendered.body).not.toContain("<h2></h2>");
    expect(rendered.body).not.toContain("<img");
  });
});

describe("compileContentBlocks 产物必须通过引擎最后一道 fail-closed 校验", () => {
  it("五种区块组合的编译产物能通过 validateStoredArticleTemplate", () => {
    const blocks: ArticleContentBlock[] = [
      { type: "heading", content: "{novel_title}" },
      { type: "image", content: "" },
      { type: "paragraph", content: "{novel_description}" },
      { type: "divider", content: "" },
      { type: "cta", content: "Start Reading" },
    ];
    expect(() => validateBody(compileContentBlocks(blocks))).not.toThrow();
  });

  it("引用未登记变量的区块被 validateStoredArticleTemplate 拒绝（防线不只在 compile-blocks 本身）", () => {
    const blocks: ArticleContentBlock[] = [{ type: "paragraph", content: "{author}" }];
    expect(() => validateBody(compileContentBlocks(blocks))).toThrow();
  });
});

describe("即使绕过 compile-blocks 手工构造越界 HTML 绑定，引擎仍然拒绝（防御纵深）", () => {
  // 🔴 这几条走的是 validateStoredArticleTemplate → renderArticleDraft → renderTemplateSlot
  // 这条路径，违规在 html.ts 的窄上下文合同上被抓到，抛出的是 TemplateRenderError
  // （code === ERR_TEMPLATE_HTML_CONTEXT），不是 storage() 那层的 ArticleTemplateInputError——
  // 两者是两道不同的闸，这里断言的是后一道。
  function expectHtmlContextRejection(bodyTemplate: string) {
    let thrown: unknown;
    try {
      validateBody(bodyTemplate);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, `expected ${JSON.stringify(bodyTemplate)} to be rejected`).toBeDefined();
    expect(isTemplateRenderError(thrown) && thrown.code === "ERR_TEMPLATE_HTML_CONTEXT", JSON.stringify(thrown)).toBe(
      true,
    );
  }

  it("试图把已登记字段塞进未授权的标签+属性组合（<script src=\"{cover_url}\">）被拒绝", () => {
    expectHtmlContextRejection('<script src="{cover_url}"></script>');
  });

  it("试图把已登记字段塞进未加引号的属性值被拒绝", () => {
    expectHtmlContextRejection("<img alt={novel_title}>");
  });

  it("cta 的固定绑定 a[href] 是唯一被授权的组合——同一字段换个属性/标签就被拒绝", () => {
    expectHtmlContextRejection('<a data-href="{promo_redirect_url}">x</a>');
    expectHtmlContextRejection('<link href="{promo_redirect_url}">');
  });
});
