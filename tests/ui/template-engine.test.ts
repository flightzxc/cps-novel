/**
 * P2-02 小说 Template Engine 行为测试。
 *
 * 放在 `tests/ui` 而不是 `tests/backend`：`src/lib/seo/` 与 `src/contracts/` 的写入方 /
 * merge custodian 都是 Claude，而 `tests/ui` 是 Claude 独占目录、对应 vitest `ui`
 * project（`tests/ui/**\/*.test.{ts,tsx}`）。引擎本身零运行时依赖，不需要 node project 环境。
 *
 * 🔴 放在 `src/` 下的测试**一条都不会被收集**（两个 project 的 include 都不覆盖 `src/`），
 * 且 `passWithNoTests: true` 会让空跑判 PASS。落点写错不会有任何提示。
 *
 * 以行为断言为主。只有两条源码扫描（纯度、不越界），它们守的是「看不见的东西不存在」
 * 这类命题——行为测试证明不了。
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ARTICLE_TEMPLATE_SLOTS,
  ERR_TEMPLATE_FIELD_NOT_REGISTERED,
  ERR_TEMPLATE_HTML_CONTEXT,
  ERR_TEMPLATE_OUTPUT_INVALID,
  ERR_TEMPLATE_SYNTAX,
  ERR_TEMPLATE_VALUE_INVALID,
  ERR_TEMPLATE_VAR_EMPTY,
  REGISTERED_TEMPLATE_FIELDS,
  TEMPLATE_ERROR_CODES,
  TEMPLATE_FIELD_KEYS,
  TEMPLATE_SEO_SCHEMA_VERSION,
  TemplateRenderError,
  analyzeHtmlInterpolation,
  analyzeTemplate,
  buildNovelTemplateValues,
  escapeHtmlText,
  isRegisteredTemplateField,
  isTemplateRenderError,
  narrowArticleTemplateSource,
  renderArticleDraft,
  renderTemplateSlot,
  type ArticleTemplateSource,
  type NovelTemplateInput,
  type NovelTemplateValues,
} from "@/lib/seo/template";

const ENGINE_DIR = path.resolve(process.cwd(), "src/lib/seo/template");

const FULL_INPUT: NovelTemplateInput = {
  title: "The Duke's Forgotten Bride",
  description: "A runaway bride, a forgotten vow, and a duke who remembers everything.",
  coverUrl: "https://cdn.example.com/cover/duke.jpg",
  totalChapterCount: 420,
  previewChapterCount: 3,
  // 站内公开跳转入口：/go/<public_redirect_code>，不是绝对 URL——引擎不读站点域名。
  promoRedirectUrl: "/go/ab12cd34",
};

function values(overrides: Partial<NovelTemplateInput> = {}): NovelTemplateValues {
  return buildNovelTemplateValues({ ...FULL_INPUT, ...overrides });
}

/** 默认按正文槽位渲染（转义 + 窄上下文合同）；纯文本槽位用 `renderText`。 */
function renderBody(template: string, map: NovelTemplateValues = values()): string {
  return renderTemplateSlot(template, map, { slot: "body", context: "html" });
}

function renderText(template: string, map: NovelTemplateValues = values()): string {
  return renderTemplateSlot(template, map, { slot: "title", context: "text" });
}

function captureError(run: () => unknown): TemplateRenderError {
  try {
    run();
  } catch (error) {
    if (error instanceof TemplateRenderError) return error;
    throw error;
  }
  throw new Error("expected the render to throw, but it returned normally");
}

const VALID_SOURCE: ArticleTemplateSource = Object.freeze({
  title: "{novel_title}",
  body: "<p>{novel_description}</p>",
  metaTitle: "{novel_title} — read online",
  metaDescription: "{novel_description}",
});

describe("字段白名单：登记什么就只能写什么", () => {
  it("🔴 已登记字段精确等于冻结的六个键——新增一项等于扩大公开面，必须走文档", () => {
    expect([...TEMPLATE_FIELD_KEYS]).toEqual([
      "novel_title",
      "novel_description",
      "cover_url",
      "total_chapter_count",
      "preview_chapter_count",
      "promo_redirect_url",
    ]);
    expect(Object.isFrozen(TEMPLATE_FIELD_KEYS)).toBe(true);
  });

  it("🔴 禁止字段一个都没混进登记表", () => {
    // 逐条覆盖 src/lib/seo/README.md 与 src/features/public-ui/types.ts 的两份禁令。
    const forbidden =
      /author|country|completion|rating|views|release|same_author|catalog|progress|split|upstream|source_label|chapter_body/i;
    for (const key of TEMPLATE_FIELD_KEYS) {
      expect(key, `${key} 命中禁止字段模式`).not.toMatch(forbidden);
    }
    for (const field of REGISTERED_TEMPLATE_FIELDS) {
      expect(isRegisteredTemplateField(field.key)).toBe(true);
    }
  });

  it("未登记的名字一律不认，包括原型链上的属性名", () => {
    for (const name of [
      "author",
      "country",
      "completion_status",
      "rating",
      "views",
      "split_ratio",
      "upstream_code",
      "site_tags",
      "novel_locale",
      "NOVEL_TITLE",
      "constructor",
      "__proto__",
      "toString",
      "",
    ]) {
      expect(isRegisteredTemplateField(name), `${name} 不应被认作已登记字段`).toBe(false);
    }
    expect(isRegisteredTemplateField(undefined)).toBe(false);
    expect(isRegisteredTemplateField(123)).toBe(false);
  });
});

describe("合法变量渲染", () => {
  it("六个登记字段各自替换正确", () => {
    expect(renderText("{novel_title}")).toBe(FULL_INPUT.title);
    expect(renderText("{novel_description}")).toBe(FULL_INPUT.description);
    expect(renderText("{cover_url}")).toBe(FULL_INPUT.coverUrl);
    expect(renderText("{total_chapter_count}")).toBe("420");
    expect(renderText("{preview_chapter_count}")).toBe("3");
    expect(renderText("{promo_redirect_url}")).toBe(FULL_INPUT.promoRedirectUrl);
  });

  it("模板自带文本原样保留，变量可重复出现、可相邻", () => {
    expect(renderText("《{novel_title}》共 {total_chapter_count} 章")).toBe(
      "《The Duke's Forgotten Bride》共 420 章",
    );
    expect(renderText("{novel_title}|{novel_title}")).toBe(
      `${FULL_INPUT.title}|${FULL_INPUT.title}`,
    );
    expect(renderText("{total_chapter_count}{preview_chapter_count}")).toBe("4203");
  });

  it("没有变量的模板原样返回；空模板返回空串", () => {
    expect(renderText("纯文案，无变量")).toBe("纯文案，无变量");
    expect(() => renderBody("   ")).not.toThrow();
  });
});

describe("条件渲染", () => {
  it("字段有值时保留块内内容，块内变量正常替换", () => {
    expect(renderText("A{if cover_url}B{cover_url}C{endif}D")).toBe(
      `AB${FULL_INPUT.coverUrl}CD`,
    );
  });

  it("空串 / 纯空白 / \"0\" 三种都移除整块，且不抛错", () => {
    expect(renderText("A{if cover_url}B{endif}C", values({ coverUrl: null }))).toBe("AC");
    expect(renderText("A{if cover_url}B{endif}C", values({ coverUrl: "   " }))).toBe("AC");
    // "0" 视为假是 CPS 的原始口径：totalChapterCount 默认 0 表示未知，不是「零章」。
    expect(renderText("A{if total_chapter_count}B{endif}C", values({ totalChapterCount: 0 }))).toBe(
      "AC",
    );
  });

  it("块被丢弃时，块内引用空值字段不会抛错——这正是可空字段的正确写法", () => {
    const map = values({ coverUrl: null });
    expect(() => renderText("{if cover_url}<img src=\"{cover_url}\">{endif}", map)).not.toThrow();
    expect(renderText("{if cover_url}X{cover_url}{endif}", map)).toBe("");
  });

  it("🔴 嵌套条件四种组合都正确——回归钉死 CPS 定点循环在外层为假时泄漏 {endif}", () => {
    // CPS 的 `/\{if\s+(\w+)\}([\s\S]*?)\{endif\}/g` + 定点循环在外层为假时输出
    // `AD{endif}E`（惰性量词吃到内层 {endif}，外层 {endif} 被剩在原地）。实测四种组合：
    //   真真 ABCDE ✅ / 真假 ABE ✅ / 假真 AD{endif}E ❌ / 假假 AD{endif}E ❌
    const template = "A{if cover_url}B{if preview_chapter_count}C{endif}D{endif}E";
    expect(renderText(template, values())).toBe("ABCDE");
    expect(renderText(template, values({ previewChapterCount: null }))).toBe("ABDE");
    expect(renderText(template, values({ coverUrl: null }))).toBe("AE");
    expect(renderText(template, values({ coverUrl: null, previewChapterCount: null }))).toBe("AE");
  });

  it("产物里绝不出现残留的 {endif} / {if …}", () => {
    const template = "A{if cover_url}B{if preview_chapter_count}C{endif}D{endif}E";
    for (const map of [
      values(),
      values({ coverUrl: null }),
      values({ previewChapterCount: null }),
      values({ coverUrl: null, previewChapterCount: null }),
    ]) {
      const out = renderText(template, map);
      expect(out).not.toContain("endif");
      expect(out).not.toContain("{if");
    }
  });

  it("同一层的多个条件块互不影响", () => {
    expect(
      renderText(
        "{if cover_url}A{endif}-{if preview_chapter_count}B{endif}",
        values({ coverUrl: null }),
      ),
    ).toBe("-B");
  });
});

describe("缺字段显式失败（fail-closed，不 fail-open 成空串）", () => {
  it("已登记字段缺值时抛 ERR_TEMPLATE_VAR_EMPTY，并带 field / slot 定位", () => {
    const error = captureError(() => renderText("{cover_url}", values({ coverUrl: null })));
    expect(error.code).toBe(ERR_TEMPLATE_VAR_EMPTY);
    expect(error.field).toBe("cover_url");
    expect(error.slot).toBe("title");
  });

  it("空串与纯空白同样算缺值", () => {
    expect(captureError(() => renderText("{novel_title}", values({ title: "" }))).code).toBe(
      ERR_TEMPLATE_VAR_EMPTY,
    );
    expect(captureError(() => renderText("{novel_title}", values({ title: "  \n " }))).code).toBe(
      ERR_TEMPLATE_VAR_EMPTY,
    );
  });

  it("错误消息只带结构化定位，不回带任何取值内容", () => {
    const secret = "javascript:alert(1)";
    const error = captureError(() => renderText("{cover_url}", values({ coverUrl: secret })));
    expect(error.code).toBe(ERR_TEMPLATE_VALUE_INVALID);
    expect(error.message).toContain("field=cover_url");
    expect(error.message).not.toContain("alert");
    expect(error.message).not.toContain(FULL_INPUT.title);
  });

  it("可选的 templateKey / novelId 会进消息，未提供时不留空占位", () => {
    const withIds = captureError(() =>
      renderTemplateSlot("{cover_url}", values({ coverUrl: null }), {
        slot: "body",
        context: "html",
        templateKey: "novel-detail-en",
        novelId: "novel-1",
      }),
    );
    expect(withIds.message).toBe(
      "ERR_TEMPLATE_VAR_EMPTY: slot=body field=cover_url templateKey=novel-detail-en novelId=novel-1",
    );
    expect(withIds.templateKey).toBe("novel-detail-en");
    expect(withIds.novelId).toBe("novel-1");

    const withoutIds = captureError(() => renderText("{cover_url}", values({ coverUrl: null })));
    expect(withoutIds.message).toBe("ERR_TEMPLATE_VAR_EMPTY: slot=title field=cover_url");
    expect(withoutIds.templateKey).toBeUndefined();
  });

  it("🔴 guard 认跨 realm 的同形对象——Worker 与 Web 不是同一个模块 realm", () => {
    expect(isTemplateRenderError(new TemplateRenderError(ERR_TEMPLATE_SYNTAX))).toBe(true);
    expect(isTemplateRenderError({ code: ERR_TEMPLATE_VAR_EMPTY })).toBe(true);
    expect(isTemplateRenderError({ code: "SOMETHING_ELSE" })).toBe(false);
    expect(isTemplateRenderError(new Error("boom"))).toBe(false);
    expect(isTemplateRenderError(null)).toBe(false);
    expect(isTemplateRenderError(undefined)).toBe(false);
  });

  it("错误码表恰好是冻结的六项", () => {
    expect([...TEMPLATE_ERROR_CODES]).toEqual([
      ERR_TEMPLATE_SYNTAX,
      ERR_TEMPLATE_FIELD_NOT_REGISTERED,
      ERR_TEMPLATE_HTML_CONTEXT,
      ERR_TEMPLATE_VAR_EMPTY,
      ERR_TEMPLATE_VALUE_INVALID,
      ERR_TEMPLATE_OUTPUT_INVALID,
    ]);
    expect(Object.isFrozen(TEMPLATE_ERROR_CODES)).toBe(true);
  });
});

describe("未登记字段拒绝（模板作者根本写不出 {author}）", () => {
  const forbiddenNames = [
    "author",
    "country",
    "completion_status",
    "rating",
    "views",
    "release_date",
    "same_author",
    "full_catalog",
    "split_ratio",
    "upstream_code",
    "source_label",
    "site_tags",
    "novel_locale",
  ];

  it("🔴 保存期：analyzeTemplate 逐个报出未登记名字", () => {
    for (const name of forbiddenNames) {
      const analysis = analyzeTemplate(`作者：{${name}}`);
      expect(analysis.unregisteredFields, `${name} 应被报为未登记`).toEqual([name]);
      expect(analysis.referencedFields).toEqual([]);
    }
  });

  it("🔴 渲染期：同一批名字全部抛 ERR_TEMPLATE_FIELD_NOT_REGISTERED，不原样透出", () => {
    for (const name of forbiddenNames) {
      const error = captureError(() => renderText(`作者：{${name}}`));
      expect(error.code, `${name} 应被拒绝`).toBe(ERR_TEMPLATE_FIELD_NOT_REGISTERED);
      expect(error.field).toBe(name);
    }
  });

  it("条件位上的未登记字段同样拒绝，不静默删块", () => {
    const error = captureError(() => renderText("{if country}X{endif}"));
    expect(error.code).toBe(ERR_TEMPLATE_FIELD_NOT_REGISTERED);
    expect(error.field).toBe("country");
  });

  it("即使未登记字段藏在一个永远不渲染的块里，也在渲染前被拒绝", () => {
    const error = captureError(() =>
      renderText("{if cover_url}{author}{endif}", values({ coverUrl: null })),
    );
    expect(error.code).toBe(ERR_TEMPLATE_FIELD_NOT_REGISTERED);
  });

  it("🔴 原型链属性名被当成未登记字段拒绝，绝不泄漏成 [object Function]", () => {
    for (const name of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      const error = captureError(() => renderText(`{${name}}`));
      expect(error.code, `${name} 应被拒绝`).toBe(ERR_TEMPLATE_FIELD_NOT_REGISTERED);
    }
  });

  it("CPS 没有的语法一律走未登记路径，不被悄悄支持", () => {
    // 嵌套路径 / filter / else：`\w+` 吃不下 `.` `|`，因此它们连 token 都不是，原样留存。
    expect(renderText("{novel.title}")).toBe("{novel.title}");
    expect(renderText("{novel_title|upper}")).toBe("{novel_title|upper}");
    // `{else}` 是合法 `\w+`，因此被当成未登记字段拒绝——不会被误当成条件分支。
    expect(captureError(() => renderText("{if cover_url}A{else}B{endif}")).code).toBe(
      ERR_TEMPLATE_FIELD_NOT_REGISTERED,
    );
  });
});

describe("语法错误（CPS 会把它当文本泄漏上线）", () => {
  it("{if} 缺 {endif} → unclosed_if", () => {
    expect(analyzeTemplate("{if cover_url}A").syntaxIssue).toBe("unclosed_if");
    const error = captureError(() => renderText("{if cover_url}A"));
    expect(error.code).toBe(ERR_TEMPLATE_SYNTAX);
    expect(error.constraint).toBe("unclosed_if");
  });

  it("游离的 {endif} → unexpected_endif，而不是一条「endif 未登记」的胡说消息", () => {
    expect(analyzeTemplate("A{endif}").syntaxIssue).toBe("unexpected_endif");
    const error = captureError(() => renderText("A{endif}"));
    expect(error.code).toBe(ERR_TEMPLATE_SYNTAX);
    expect(error.constraint).toBe("unexpected_endif");
    expect(error.field).toBeUndefined();
  });

  it("配对数量相同但顺序错乱同样被抓住", () => {
    expect(analyzeTemplate("{if cover_url}{endif}{endif}{if cover_url}").syntaxIssue).toBe(
      "unexpected_endif",
    );
  });

  it("语法错误优先于未登记字段——模板本身先得是合法的", () => {
    expect(captureError(() => renderText("{if cover_url}{author}")).code).toBe(ERR_TEMPLATE_SYNTAX);
  });

  it("合法配对不报语法问题，且 endif 不被当成字段", () => {
    const analysis = analyzeTemplate("{if cover_url}{novel_title}{endif}");
    expect(analysis.syntaxIssue).toBeNull();
    expect(analysis.unregisteredFields).toEqual([]);
    expect(analysis.referencedFields).toEqual(["cover_url", "novel_title"]);
  });
});

describe("HTML 转义：保留 CPS 的模板语言，丢掉 CPS 的注入缺陷", () => {
  it("正文槽位对插入的取值做实体转义", () => {
    expect(escapeHtmlText(`Cat & Dog <b>"x"</b> 'y'`)).toBe(
      "Cat &amp; Dog &lt;b&gt;&quot;x&quot;&lt;/b&gt; &#39;y&#39;",
    );
    const map = values({ title: '<script>alert("x")</script>' });
    expect(renderBody("<h1>{novel_title}</h1>", map)).toBe(
      "<h1>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</h1>",
    );
  });

  it("模板自带的 HTML 标签原样保留，只有取值被转义", () => {
    const out = renderBody("<p class=\"lead\">{novel_description}</p>");
    expect(out).toBe(`<p class="lead">${FULL_INPUT.description}</p>`);
  });

  it("属性上下文里的取值无法逃逸", () => {
    const map = values({ coverUrl: "https://cdn.example.com/a.jpg?a=1&b=2" });
    expect(renderBody('<img src="{cover_url}" alt="">', map)).toBe(
      '<img src="https://cdn.example.com/a.jpg?a=1&amp;b=2" alt="">',
    );
  });

  it("纯文本槽位不转义——它们进 metadata 与文本节点，由渲染层处理编码", () => {
    const map = values({ title: 'A & B "C"' });
    expect(renderText("{novel_title}", map)).toBe('A & B "C"');
  });

  it("条件块内的模板文本不转义，块内的取值转义", () => {
    const map = values({ title: "A & B" });
    expect(renderBody("{if novel_title}<em>{novel_title}</em>{endif}", map)).toBe(
      "<em>A &amp; B</em>",
    );
  });

  it("🔴 取值里的 {novel_title} 不会被二次展开（替换是一次性的）", () => {
    const map = values({ title: "{novel_description}" });
    expect(renderText("{novel_title}")).not.toContain("{");
    expect(renderText("{novel_title}", map)).toBe("{novel_description}");
    expect(renderBody("{novel_title}", map)).toBe("{novel_description}");
  });

  it("取值里的 {if …} 也不会被当成语法", () => {
    const map = values({ title: "{if cover_url}X{endif}" });
    expect(renderText("{novel_title}", map)).toBe("{if cover_url}X{endif}");
  });
});

describe("取值形态校验：逐字段独立，不共用一条 URL 规则", () => {
  describe("cover_url：站外资源，只认干净的绝对 http/https", () => {
    it("http / https 绝对地址通过（现有行为保持）", () => {
      expect(renderText("{cover_url}", values({ coverUrl: "http://a.example.com/x.jpg" }))).toBe(
        "http://a.example.com/x.jpg",
      );
      expect(renderText("{cover_url}", values({ coverUrl: "https://a.example.com/x.jpg" }))).toBe(
        "https://a.example.com/x.jpg",
      );
      expect(
        renderText("{cover_url}", values({ coverUrl: "https://a.example.com/x.jpg?a=1&b=2#f" })),
      ).toBe("https://a.example.com/x.jpg?a=1&b=2#f");
    });

    it("危险 scheme / 相对路径 / 协议相对 / 逃逸字符 / 反斜杠 / 控制字符一律拒绝", () => {
      for (const bad of [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "data:text/html;base64,PHNjcmlwdD4=",
        "/covers/a.jpg",
        "covers/a.jpg",
        "//cdn.example.com/a.jpg",
        "/go/ab12cd34",
        'https://a.example.com/a.jpg" onerror="x',
        "https://a.example.com/a'b.jpg",
        "https://a.example.com/a<b>.jpg",
        "https://a.example.com/a b.jpg",
        "https://a.example.com/a\\b.jpg",
        "https://a.example.com/a\u0000b.jpg",
        "https://a.example.com/a\tb.jpg",
        "https://a.example.com/a\u007fb.jpg",
        "ftp://a.example.com/a.jpg",
      ]) {
        const error = captureError(() => renderText("{cover_url}", values({ coverUrl: bad })));
        expect(error.code, `${JSON.stringify(bad)} 应被拒绝`).toBe(ERR_TEMPLATE_VALUE_INVALID);
        expect(error.field).toBe("cover_url");
        expect(error.constraint).toBe("absolute_url");
      }
    });
  });

  describe("promo_redirect_url：站内公开跳转入口 /go/<公开跳转码>", () => {
    it("🔴 合法的 /go/<码> 通过——这是冻结的公开入口形态，不依赖站点域名", () => {
      for (const good of ["/go/ab12cd34", "/go/a1", "/go/AB12cd34", "/go/" + "a1".repeat(16)]) {
        expect(renderText("{promo_redirect_url}", values({ promoRedirectUrl: good }))).toBe(good);
      }
    });

    it("协议相对、危险 scheme、路径穿越、多段、空白/控制字符、反斜杠一律拒绝", () => {
      for (const bad of [
        "//evil.example",
        "//evil.example/go/ab12",
        "javascript:alert(1)",
        "data:text/html,x",
        "/go/../admin",
        "/go/ab/cd",
        "/go/",
        "/go/ab 12",
        "/go/ab\t12",
        "/go/ab\n12",
        "/go/ab\u000012",
        "/go/ab%2f..",
        "/go/ab\\cd",
        '/go/ab"onerror=x',
        "/go/ab'onerror=x",
        "/go/<script>",
        "/goo/ab12",
        "go/ab12",
        "/GO/ab12",
        // 超过 PromoLink.publicRedirectCode 的 VarChar(32)
        "/go/" + "a".repeat(33),
      ]) {
        const error = captureError(() =>
          renderText("{promo_redirect_url}", values({ promoRedirectUrl: bad })),
        );
        expect(error.code, `${JSON.stringify(bad)} 应被拒绝`).toBe(ERR_TEMPLATE_VALUE_INVALID);
        expect(error.field).toBe("promo_redirect_url");
        expect(error.constraint).toBe("redirect_path");
      }
    });

    it("绝对 URL 也被拒绝——当前合同里没有它的证据，不为未来可能性开口子", () => {
      expect(
        captureError(() =>
          renderText("{promo_redirect_url}", values({ promoRedirectUrl: "https://x.example/go/ab12" })),
        ).code,
      ).toBe(ERR_TEMPLATE_VALUE_INVALID);
    });
  });

  it("text 类字段不做形态校验", () => {
    expect(renderText("{novel_description}", values({ description: "javascript:not a url" }))).toBe(
      "javascript:not a url",
    );
    expect(renderText("{novel_title}", values({ title: "//evil.example" }))).toBe("//evil.example");
  });
});

describe("🔴 正文 HTML 插值的窄上下文合同", () => {
  const htmlError = (template: string) => captureError(() => renderBody(template));

  it("A. 文本节点插值放行，且正确转义", () => {
    expect(renderBody("<p>{novel_title}</p>", values({ title: "A & <b>" }))).toBe(
      "<p>A &amp; &lt;b&gt;</p>",
    );
    expect(renderBody("{novel_description}")).toBe(FULL_INPUT.description);
    expect(renderBody("<div><span>{total_chapter_count}</span></div>")).toBe(
      "<div><span>420</span></div>",
    );
    expect(analyzeHtmlInterpolation("<p>{novel_title}</p>")).toEqual([]);
  });

  it("B. 已授权的带引号属性放行：href={promo_redirect_url} / src={cover_url}", () => {
    expect(renderBody('<a href="{promo_redirect_url}">read</a>')).toBe(
      `<a href="${FULL_INPUT.promoRedirectUrl}">read</a>`,
    );
    expect(renderBody("<a href='{promo_redirect_url}'>read</a>")).toBe(
      `<a href='${FULL_INPUT.promoRedirectUrl}'>read</a>`,
    );
    expect(renderBody('<img src="{cover_url}" alt="">')).toBe(
      `<img src="${FULL_INPUT.coverUrl}" alt="">`,
    );
    expect(analyzeHtmlInterpolation('<a href="{promo_redirect_url}"></a>')).toEqual([]);
  });

  it("🔴 未加引号的属性值拒绝——取值里一个空格就能造出新属性", () => {
    for (const template of [
      "<img alt={novel_title}>",
      "<a href={promo_redirect_url}>x</a>",
      "<img src={cover_url}>",
      "<img alt={novel_title} >",
    ]) {
      const error = htmlError(template);
      expect(error.code, `${template} 应被拒绝`).toBe(ERR_TEMPLATE_HTML_CONTEXT);
      expect(error.constraint).toBe("unquoted_attribute");
    }
  });

  it("🔴 事件属性拒绝（JS 上下文，实体转义无意义）", () => {
    for (const template of [
      '<div onclick="{novel_title}">x</div>',
      '<div ONCLICK="{novel_title}">x</div>',
      '<img onerror="{cover_url}">',
      '<body onload="{novel_description}">',
    ]) {
      const error = htmlError(template);
      expect(error.code, `${template} 应被拒绝`).toBe(ERR_TEMPLATE_HTML_CONTEXT);
      expect(error.constraint).toBe("event_attribute");
    }
  });

  it("🔴 style 属性拒绝（CSS 上下文）", () => {
    const error = htmlError('<div style="{novel_title}">x</div>');
    expect(error.code).toBe(ERR_TEMPLATE_HTML_CONTEXT);
    expect(error.constraint).toBe("style_attribute");
    expect(error.attribute).toBe("style");
  });

  it("🔴 script / style 块内拒绝", () => {
    expect(htmlError("<script>{novel_title}</script>").constraint).toBe("script_block");
    expect(htmlError('<script type="text/javascript">{cover_url}</script>').constraint).toBe(
      "script_block",
    );
    expect(htmlError("<style>{novel_title}</style>").constraint).toBe("style_block");
    // 未闭合的 script 块同样一路算到模板末尾。
    expect(htmlError("<script>{novel_title}").constraint).toBe("script_block");
  });

  it("🔴 标签名与属性名位置拒绝", () => {
    expect(htmlError("<{novel_title}>x</p>").constraint).toBe("tag_name");
    expect(htmlError("</{novel_title}>").constraint).toBe("tag_name");
    expect(htmlError('<img {novel_title}="x">').constraint).toBe("attribute_name");
    expect(htmlError('<img data-{novel_title}="x">').constraint).toBe("attribute_name");
  });

  it("🔴 HTML 注释内拒绝", () => {
    expect(htmlError("<!-- {novel_title} -->").constraint).toBe("comment");
    expect(htmlError("<!-- 未闭合 {cover_url}").constraint).toBe("comment");
  });

  it("🔴 未授权的属性拒绝——文本属性不预建", () => {
    for (const template of [
      '<img alt="{novel_title}">',
      '<div title="{novel_description}">x</div>',
      '<img src="{promo_redirect_url}">',
      '<a href="{cover_url}">x</a>',
      '<a href="{novel_title}">x</a>',
      '<meta content="{novel_description}">',
    ]) {
      const error = htmlError(template);
      expect(error.code, `${template} 应被拒绝`).toBe(ERR_TEMPLATE_HTML_CONTEXT);
      expect(error.constraint).toBe("attribute_not_permitted");
    }
  });

  it("🔴 属性值里的拼接拒绝——这是 scheme 注入的唯一入口", () => {
    for (const template of [
      '<a href="javascript:{promo_redirect_url}">x</a>',
      '<a href="/x{promo_redirect_url}">x</a>',
      '<a href="{promo_redirect_url}?a=1">x</a>',
      '<img src="{cover_url}{cover_url}">',
      '<a href="{if cover_url}{promo_redirect_url}{endif}">x</a>',
      '<a href=" {promo_redirect_url}">x</a>',
    ]) {
      const error = htmlError(template);
      expect(error.code, `${template} 应被拒绝`).toBe(ERR_TEMPLATE_HTML_CONTEXT);
      expect(error.constraint).toBe("value_not_isolated");
    }
  });

  it("条件块包裹整段标签是被支持的写法", () => {
    const template = '{if cover_url}<img src="{cover_url}" alt="">{endif}';
    expect(analyzeHtmlInterpolation(template)).toEqual([]);
    expect(renderBody(template)).toBe(`<img src="${FULL_INPUT.coverUrl}" alt="">`);
    expect(renderBody(template, values({ coverUrl: null }))).toBe("");
  });

  it("不含变量的属性与标签不受影响", () => {
    expect(analyzeHtmlInterpolation('<div class="a" onclick="go()" style="color:red"></div>')).toEqual(
      [],
    );
    expect(analyzeHtmlInterpolation("<script>var a = 1;</script>")).toEqual([]);
    expect(renderBody('<p class="lead">{novel_description}</p>')).toBe(
      `<p class="lead">${FULL_INPUT.description}</p>`,
    );
  });

  it("纯文本槽位不做 HTML 判定——它们不是 HTML", () => {
    expect(renderText("<img alt={novel_title}>")).toBe(`<img alt=${FULL_INPUT.title}>`);
    expect(renderText("<script>{novel_title}</script>")).toBe(
      `<script>${FULL_INPUT.title}</script>`,
    );
  });

  it("analyzeHtmlInterpolation 可在保存期单独调用，逐条报出违规", () => {
    const issues = analyzeHtmlInterpolation(
      '<img alt={novel_title}><div style="{novel_description}">x</div>',
    );
    expect(issues).toEqual([
      { field: "novel_title", reason: "unquoted_attribute", attribute: "alt" },
      { field: "novel_description", reason: "style_attribute", attribute: "style" },
    ]);
  });
});

describe("可空字段裸引用的保存期告警", () => {
  it("裸引用可空字段被报为 unguardedOptionalFields", () => {
    expect(analyzeTemplate("<img src=\"{cover_url}\">").unguardedOptionalFields).toEqual([
      "cover_url",
    ]);
    expect(analyzeTemplate("{total_chapter_count} 章").unguardedOptionalFields).toEqual([
      "total_chapter_count",
    ]);
  });

  it("被同名条件块包住就不再告警（含嵌套层）", () => {
    expect(
      analyzeTemplate("{if cover_url}<img src=\"{cover_url}\">{endif}").unguardedOptionalFields,
    ).toEqual([]);
    expect(
      analyzeTemplate("{if cover_url}{if novel_title}{cover_url}{endif}{endif}")
        .unguardedOptionalFields,
    ).toEqual([]);
  });

  it("被别的字段的条件块包住不算包住", () => {
    expect(
      analyzeTemplate("{if novel_title}{cover_url}{endif}").unguardedOptionalFields,
    ).toEqual(["cover_url"]);
  });

  it("非空列字段裸引用不告警", () => {
    expect(analyzeTemplate("{novel_title}{novel_description}").unguardedOptionalFields).toEqual([]);
    expect(analyzeTemplate("{promo_redirect_url}").unguardedOptionalFields).toEqual([]);
  });
});

describe("取值表构建", () => {
  it("恒含全部登记键，缺失值折成空串而不是 undefined", () => {
    const map = buildNovelTemplateValues({ title: "T", description: "D", totalChapterCount: 1 });
    expect([...map.keys()].sort()).toEqual([...TEMPLATE_FIELD_KEYS].sort());
    for (const key of TEMPLATE_FIELD_KEYS) {
      expect(typeof map.get(key), `${key} 必须是字符串`).toBe("string");
    }
    expect(map.get("cover_url")).toBe("");
    expect(map.get("promo_redirect_url")).toBe("");
  });

  it("计数字段：0 保留为 \"0\"，负数 / 小数 / NaN / null 一律折成空串", () => {
    expect(values({ totalChapterCount: 0 }).get("total_chapter_count")).toBe("0");
    expect(values({ totalChapterCount: -1 }).get("total_chapter_count")).toBe("");
    expect(values({ totalChapterCount: 1.5 }).get("total_chapter_count")).toBe("");
    expect(values({ totalChapterCount: Number.NaN }).get("total_chapter_count")).toBe("");
    expect(values({ totalChapterCount: null }).get("total_chapter_count")).toBe("");
  });

  it("文本字段两端空白被裁掉", () => {
    expect(values({ title: "  T  " }).get("novel_title")).toBe("T");
    expect(values({ coverUrl: null }).get("cover_url")).toBe("");
  });

  it("🔴 用 Map 承载，原型链属性名取不到任何东西", () => {
    const map = values();
    expect(map.get("constructor" as never)).toBeUndefined();
    expect(map.get("__proto__" as never)).toBeUndefined();
    expect(map.get("toString" as never)).toBeUndefined();
  });
});

describe("模板记录归一（narrowArticleTemplateSource）", () => {
  const base = {
    schemaVersion: TEMPLATE_SEO_SCHEMA_VERSION,
    bodyTemplate: "<p>{novel_description}</p>",
    seoTemplate: { title: "{novel_title}", metaTitle: "M", metaDescription: "D" },
  };

  it("合法输入归一成四槽位", () => {
    expect(narrowArticleTemplateSource(base)).toEqual({
      title: "{novel_title}",
      body: "<p>{novel_description}</p>",
      metaTitle: "M",
      metaDescription: "D",
    });
  });

  it("两个 meta 槽位缺省时，产物里就没有那两个键（不是空串、不是 null）", () => {
    const source = narrowArticleTemplateSource({
      ...base,
      seoTemplate: { title: "{novel_title}" },
    });
    expect(source).not.toBeNull();
    expect(Object.keys(source ?? {}).sort()).toEqual(["body", "title"]);
  });

  it("🔴 未知 schemaVersion 一律 fail-closed 返回 null，不做 best-effort 解析", () => {
    expect(narrowArticleTemplateSource({ ...base, schemaVersion: 2 })).toBeNull();
    expect(narrowArticleTemplateSource({ ...base, schemaVersion: 0 })).toBeNull();
    expect(narrowArticleTemplateSource({ ...base, schemaVersion: "1" })).toBeNull();
    expect(narrowArticleTemplateSource({ ...base, schemaVersion: undefined })).toBeNull();
  });

  it("形态不合的输入返回 null 而不是抛异常", () => {
    for (const bad of [
      null,
      undefined,
      "template",
      42,
      { ...base, bodyTemplate: "" },
      { ...base, bodyTemplate: "   " },
      { ...base, bodyTemplate: 42 },
      { ...base, seoTemplate: null },
      { ...base, seoTemplate: [] },
      { ...base, seoTemplate: "title" },
      { ...base, seoTemplate: {} },
      { ...base, seoTemplate: { title: "" } },
      { ...base, seoTemplate: { title: 42 } },
      { ...base, seoTemplate: { title: "T", metaTitle: 42 } },
      { ...base, seoTemplate: { title: "T", metaDescription: null } },
    ]) {
      expect(() => narrowArticleTemplateSource(bad)).not.toThrow();
      expect(narrowArticleTemplateSource(bad), `${JSON.stringify(bad)} 应被拒绝`).toBeNull();
    }
  });
});

describe("四槽位装配与输出合同", () => {
  it("四个槽位名精确等于冻结集合，且与 P2-01 的 title / body 同名", () => {
    expect([...ARTICLE_TEMPLATE_SLOTS]).toEqual(["title", "body", "metaTitle", "metaDescription"]);
    expect(Object.isFrozen(ARTICLE_TEMPLATE_SLOTS)).toBe(true);
  });

  it("正常输入产出非空 body 与完整产物形状", () => {
    const draft = renderArticleDraft(VALID_SOURCE, values());
    expect(Object.keys(draft).sort()).toEqual(["body", "seoMetadata", "seoSchemaVersion", "title"]);
    expect(draft.title).toBe(FULL_INPUT.title);
    expect(draft.body).toBe(`<p>${FULL_INPUT.description}</p>`);
    expect(draft.body.trim()).not.toBe("");
    expect(Object.keys(draft.seoMetadata).sort()).toEqual(["metaDescription", "metaTitle"]);
    expect(draft.seoSchemaVersion).toBe(TEMPLATE_SEO_SCHEMA_VERSION);
  });

  it("模板没写 meta 槽位时，产物里就没有那个键——不做任何 fallback", () => {
    const draft = renderArticleDraft({ title: "{novel_title}", body: "<p>x</p>" }, values());
    expect(draft.seoMetadata).toEqual({});
    expect("metaTitle" in draft.seoMetadata).toBe(false);
  });

  it("🔴 渲染后 trim 为空的槽位被拒绝——对齐 article 表的 btrim(...) <> ''", () => {
    const source: ArticleTemplateSource = {
      title: "{novel_title}",
      body: "  {if cover_url}<p>x</p>{endif}  ",
    };
    const error = captureError(() => renderArticleDraft(source, values({ coverUrl: null })));
    expect(error.code).toBe(ERR_TEMPLATE_OUTPUT_INVALID);
    expect(error.slot).toBe("body");
    expect(error.constraint).toBe("empty");
  });

  it("🔴 title 超过 VarChar(500) 被拒绝，而不是留给 INSERT 炸出裸 Postgres 错误", () => {
    const long = "字".repeat(501);
    const error = captureError(() =>
      renderArticleDraft(VALID_SOURCE, values({ title: long })),
    );
    expect(error.code).toBe(ERR_TEMPLATE_OUTPUT_INVALID);
    expect(error.slot).toBe("title");
    expect(error.constraint).toBe("too_long");
    // 恰好 500 通过。
    expect(renderArticleDraft(VALID_SOURCE, values({ title: "字".repeat(500) })).title).toHaveLength(
      500,
    );
  });

  it("任一槽位失败即整体抛错，不产出半成品", () => {
    const source: ArticleTemplateSource = {
      title: "{novel_title}",
      body: "<p>{cover_url}</p>",
    };
    expect(() => renderArticleDraft(source, values({ coverUrl: null }))).toThrow(
      TemplateRenderError,
    );
  });

  it("槽位定位信息随错误一起返回，便于 P2-07 映射到 required_metadata_missing", () => {
    const error = captureError(() =>
      renderArticleDraft({ title: "{cover_url}", body: "<p>x</p>" }, values({ coverUrl: null }), {
        templateKey: "novel-detail-en",
        novelId: "novel-1",
      }),
    );
    expect(error.slot).toBe("title");
    expect(error.templateKey).toBe("novel-detail-en");
    expect(error.novelId).toBe("novel-1");
  });
});

describe("产物不含 undefined / null 一类的字面串", () => {
  it("完整输入与部分缺失输入下，产物都不出现占位字面串", () => {
    const source: ArticleTemplateSource = {
      title: "{novel_title}",
      body: "<p>{novel_description}</p>{if cover_url}<img src=\"{cover_url}\">{endif}{if total_chapter_count}<span>{total_chapter_count}</span>{endif}",
      metaTitle: "{novel_title}",
      metaDescription: "{novel_description}",
    };
    for (const map of [
      values(),
      values({ coverUrl: null }),
      values({ totalChapterCount: 0 }),
      values({ coverUrl: null, totalChapterCount: null, previewChapterCount: null }),
    ]) {
      const serialized = JSON.stringify(renderArticleDraft(source, map));
      for (const junk of ["undefined", "null", "NaN", "[object", "{if", "endif"]) {
        expect(serialized, `产物不应含 ${junk}`).not.toContain(junk);
      }
    }
  });
});

describe("确定性", () => {
  it("同一输入渲染多次逐字节相等", () => {
    const map = values();
    const first = JSON.stringify(renderArticleDraft(VALID_SOURCE, map));
    for (let i = 0; i < 50; i += 1) {
      expect(JSON.stringify(renderArticleDraft(VALID_SOURCE, values()))).toBe(first);
    }
  });

  it("取值表的键序不影响产物", () => {
    const forward = renderArticleDraft(VALID_SOURCE, values());
    const reversed = new Map([...values().entries()].reverse());
    expect(renderArticleDraft(VALID_SOURCE, reversed)).toEqual(forward);
  });

  it("analyzeTemplate 对同一模板恒等输出", () => {
    const template = "{if cover_url}{cover_url}{endif}{novel_title}{author}";
    expect(analyzeTemplate(template)).toEqual(analyzeTemplate(template));
  });

  it("连续渲染不受正则 lastIndex 残留影响（全局正则被复用）", () => {
    const template = "{novel_title}|{novel_title}";
    const once = renderText(template);
    expect(renderText(template)).toBe(once);
    expect(analyzeTemplate(template).referencedFields).toEqual(["novel_title"]);
    expect(analyzeTemplate(template).referencedFields).toEqual(["novel_title"]);
  });
});

describe("🔴 纯度与边界：源码级守卫", () => {
  async function engineSources(): Promise<Array<{ file: string; source: string }>> {
    const entries = await readdir(ENGINE_DIR, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    return Promise.all(
      files.map(async (entry) => ({
        file: `src/lib/seo/template/${entry.name}`,
        source: await readFile(path.join(ENGINE_DIR, entry.name), "utf8"),
      })),
    );
  }

  it("引擎不取当前时间、不产生随机数、不读环境变量、不做本地化", async () => {
    for (const { file, source } of await engineSources()) {
      for (const pattern of [
        /new\s+Date\b/,
        /Date\s*\.\s*now/,
        /Math\s*\.\s*random/,
        /process\s*\.\s*env/,
        /toLocale[A-Za-z]*\s*\(/,
        /\bIntl\b/,
        /performance\s*\.\s*now/,
      ]) {
        expect(source, `${file} 命中非确定性来源 ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("引擎不 import 数据库 / 服务端 / 路由 / React / Node 内建，也不越界进 P2-03 的目录", async () => {
    for (const { file, source } of await engineSources()) {
      const importLines = source
        .split("\n")
        .filter((line) => /^\s*(import|export)\b[^\n]*\bfrom\b/.test(line));
      for (const line of importLines) {
        for (const pattern of [
          /"node:/,
          /"@prisma\/client"/,
          /"react/,
          /"next/,
          /"@\/server/,
          /"@\/lib\/db/,
          /"@\/lib\/slug/,
          /"@\/lib\/redirect/,
          /"@\/lib\/seo\/url/,
          /"@\/app/,
          /"@\/features/,
        ]) {
          expect(line, `${file} 的 import 越界：${line.trim()}`).not.toMatch(pattern);
        }
      }
    }
  });

  it("引擎源码里没有 CPS 仓库目录名——项目隔离检查会逐文件 grep", async () => {
    for (const { file, source } of await engineSources()) {
      expect(source, `${file} 不得出现 CPS 仓库目录名`).not.toContain("cps-admin");
    }
  });
});
