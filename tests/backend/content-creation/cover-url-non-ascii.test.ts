/**
 * B-47：封面网址路径里含非 ASCII 字符时，文章生成不再因 `cover_url` 的 absolute_url 校验失败。
 *
 * 2026-10-15/16 PlotNovel 四波放量有 58 本 finalize_failed / TemplateRenderError
 * （ERR_TEMPLATE_VALUE_INVALID, field=cover_url, constraint=absolute_url）。这里走生成任务实际调用的
 * `renderNovelArticleDraft`，并带上口令码剧场配置，复现那条路径。
 */
import { describe, expect, it } from "vitest";

import { ERR_TEMPLATE_VALUE_INVALID, TemplateRenderError } from "@/lib/seo/template";
import { DEFAULT_ARTICLE_TEMPLATE } from "@/server/content-creation/default-article-template";
import { renderNovelArticleDraft } from "@/server/content-creation/render-novel-article";

const CODE_CONFIG = { promoMode: "code", agencyIds: ["1351"], appDisplayName: "PlotNovel", codeModeLocales: ["en"] };

function render(coverUrl: string | null) {
  return renderNovelArticleDraft({
    source: DEFAULT_ARTICLE_TEMPLATE,
    templateKey: "test",
    novel: { id: "n1", title: "Fifty Million For Ten Years", description: "A wife, ten years.", coverUrl, totalChapterCount: 20 },
    previewChapterCount: 3,
    promoPublicRedirectCode: "abc123xy9z",
    promoTheaterConfig: CODE_CONFIG,
  });
}

describe("B-47 封面网址含非 ASCII 字符", () => {
  it("路径含中文的封面：渲染成功，正文 img[src] 是 UTF-8 百分号编码后的地址", () => {
    const draft = render("https://img.example/temp/封面2.jpg");
    expect(draft.body).toContain('<img src="https://img.example/temp/%E5%B0%81%E9%9D%A22.jpg" alt="Cover">');
    expect(draft.body).toContain('<a href="/go/abc123xy9z">Read on PlotNovel App</a>');
  });

  it("纯 ASCII 封面：产物与改动前逐字相同", () => {
    expect(render("https://img.example/c.jpg").body).toContain('<img src="https://img.example/c.jpg" alt="Cover">');
  });

  it("没有封面：整块图片照旧省略", () => {
    expect(render(null).body).not.toContain("<img");
  });

  it("🔴 安全合同不变：除非 ASCII 外还带引号的封面仍以 absolute_url 拒绝", () => {
    let caught: unknown;
    try {
      render('https://img.example/封.jpg" onerror="x');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TemplateRenderError);
    expect((caught as TemplateRenderError).code).toBe(ERR_TEMPLATE_VALUE_INVALID);
    expect((caught as TemplateRenderError).field).toBe("cover_url");
    expect((caught as TemplateRenderError).constraint).toBe("absolute_url");
  });
});
