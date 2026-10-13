/**
 * v0.6.0 F.4：口令码模式剧场的文章号召文案。
 * 正文里固化的仍是 `/go/<站内码>`；只在口令码模式下，指向它的号召链接文字换成英文 "Read on {App} App"。
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_ARTICLE_TEMPLATE } from "@/server/content-creation/default-article-template";
import { applyCodeModeArticleCta, replaceRedirectAnchorLabel } from "@/server/content-creation/code-mode-cta";
import { renderNovelArticleDraft } from "@/server/content-creation/render-novel-article";

const CODE_CONFIG = { promoMode: "code", agencyIds: ["1351"], appDisplayName: "PlotNovel", codeModeLocales: ["en"] };
const NOVEL = { id: "n1", title: "Fifty Million For Ten Years", description: "A wife, ten years.", coverUrl: "https://img.example/c.jpg", totalChapterCount: 20 };
const PATH = "/go/abc123xy9z";

function render(promoTheaterConfig: unknown) {
  return renderNovelArticleDraft({
    source: DEFAULT_ARTICLE_TEMPLATE,
    templateKey: "test",
    novel: NOVEL,
    previewChapterCount: 3,
    promoPublicRedirectCode: "abc123xy9z",
    promoTheaterConfig,
  });
}

describe("replaceRedirectAnchorLabel", () => {
  it("只换指向站内跳转入口的链接文字；别的链接、别的文字原样", () => {
    const body = `<p><a href="${PATH}">Start Reading</a></p><p><a href="https://other.example/x">Other</a></p><p>Start Reading</p>`;
    expect(replaceRedirectAnchorLabel(body, PATH, "Read on PlotNovel App")).toBe(
      `<p><a href="${PATH}">Read on PlotNovel App</a></p><p><a href="https://other.example/x">Other</a></p><p>Start Reading</p>`,
    );
  });

  it("同一入口出现多次就都换；路径里的正则元字符被转义（不会误匹配别的链接）", () => {
    const body = `<a href="${PATH}">A</a> <a class="cta" href="${PATH}">B</a> <a href="/go/abcX23xy9z">C</a>`;
    expect(replaceRedirectAnchorLabel(body, PATH, "L")).toBe(`<a href="${PATH}">L</a> <a class="cta" href="${PATH}">L</a> <a href="/go/abcX23xy9z">C</a>`);
    expect(replaceRedirectAnchorLabel('<a href="/go/a.b">x</a><a href="/go/aXb">y</a>', "/go/a.b", "L")).toBe('<a href="/go/a.b">L</a><a href="/go/aXb">y</a>');
  });

  it("文案按 HTML 转义写入（App 名来自配置，不能把标记带进正文）", () => {
    expect(replaceRedirectAnchorLabel(`<a href="${PATH}">x</a>`, PATH, '<b>"A&B"</b>')).toBe(`<a href="${PATH}">&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;</a>`);
  });
});

describe("applyCodeModeArticleCta", () => {
  it("link 模式 / 剧场信息缺失 / 没有跳转入口：原样返回同一个对象", () => {
    const draft = { body: `<a href="${PATH}">Start Reading</a>`, title: "t" };
    expect(applyCodeModeArticleCta(draft, { redirectPath: PATH, theaterConfig: { promoMode: "link" } })).toBe(draft);
    expect(applyCodeModeArticleCta(draft, { redirectPath: PATH, theaterConfig: {} })).toBe(draft);
    expect(applyCodeModeArticleCta(draft, { redirectPath: PATH, theaterConfig: undefined })).toBe(draft);
    expect(applyCodeModeArticleCta(draft, { redirectPath: undefined, theaterConfig: CODE_CONFIG })).toBe(draft);
  });
});

describe("renderNovelArticleDraft 接入口令码模式", () => {
  it("口令码模式：号召链接仍是 /go/<站内码>，文字是 Read on PlotNovel App，其余正文不变", () => {
    const linkDraft = render({ promoMode: "link" });
    const codeDraft = render(CODE_CONFIG);
    expect(linkDraft.body).toContain(`<a href="${PATH}">Start Reading</a>`);
    expect(codeDraft.body).toContain(`<a href="${PATH}">Read on PlotNovel App</a>`);
    expect(codeDraft.body.replace("Read on PlotNovel App", "Start Reading")).toBe(linkDraft.body);
    // SEO 字段、标题不受影响
    expect(codeDraft.title).toBe(linkDraft.title);
    expect(codeDraft.seoMetadata).toEqual(linkDraft.seoMetadata);
  });

  it("link 模式与不传剧场信息：产物逐字相同（改动前后一致）", () => {
    const legacy = renderNovelArticleDraft({ source: DEFAULT_ARTICLE_TEMPLATE, templateKey: "test", novel: NOVEL, previewChapterCount: 3, promoPublicRedirectCode: "abc123xy9z" });
    expect(render({ promoMode: "link" })).toEqual(legacy);
    expect(render(undefined)).toEqual(legacy);
    expect(render({})).toEqual(legacy);
  });

  it("App 名取自剧场配置", () => {
    expect(render({ ...CODE_CONFIG, appDisplayName: "ReadNow" }).body).toContain(`<a href="${PATH}">Read on ReadNow App</a>`);
  });

  it("没有绑定推广链接（没有站内码）的文章不受影响", () => {
    const draft = renderNovelArticleDraft({ source: DEFAULT_ARTICLE_TEMPLATE, templateKey: "test", novel: NOVEL, previewChapterCount: 3, promoTheaterConfig: CODE_CONFIG });
    expect(draft.body).not.toContain("Read on");
    expect(draft.body).not.toContain("/go/");
  });
});
