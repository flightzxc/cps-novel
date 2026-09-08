import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.7). Source-text
 * assertions for `[articleId]/page.tsx`'s wiring — same "async Server
 * Component, no render-based unit test precedent" mechanism
 * `articles-new-blog.test.tsx`'s C-28/C-29 blocks already use.
 */
const root = resolve(import.meta.dirname, "../..");
const pageSource = readFileSync(resolve(root, "src/app/(admin)/articles/[articleId]/page.tsx"), "utf8");

describe("ArticleEditPage · C-30A 换绑面板接线（源码级断言）", () => {
  it("面板只出现在 novel_article 分支（article.novel !== null）内，博客分支不渲染", () => {
    const blogBranchStart = pageSource.indexOf("article.novel === null ? (");
    const elseBranchStart = pageSource.indexOf(") : (", blogBranchStart);
    const rebindPanelIdx = pageSource.indexOf("<ArticleRebindPanel", elseBranchStart);
    expect(blogBranchStart).toBeGreaterThan(-1);
    expect(elseBranchStart).toBeGreaterThan(blogBranchStart);
    expect(rebindPanelIdx).toBeGreaterThan(elseBranchStart);
    // Not present before the `) : (` else-branch marker, i.e. not inside the
    // blog branch.
    expect(pageSource.slice(blogBranchStart, elseBranchStart)).not.toContain("ArticleRebindPanel");
  });

  it("总闸 FEATURE_ARTICLE_NOVEL_REBIND 关闭时不渲染面板（rebindView 在关闸时为 null）", () => {
    expect(pageSource).toContain("isArticleNovelRebindEnabled(process.env)");
    expect(pageSource).toMatch(/rebindEnabled\s*\?\s*await getRebindView/);
    expect(pageSource).toMatch(/\{rebindView\s*&&\s*\(/);
  });

  it("能力位读取 content:rebind（不是复用 content:publish）", () => {
    expect(pageSource).toContain('findCapabilityState(capabilityViews(context), "content:rebind")');
  });
});
