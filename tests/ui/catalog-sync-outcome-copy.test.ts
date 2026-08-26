import { describe, expect, it } from "vitest";

import {
  describeCreateContentOutcome,
  type CreateContentResult,
} from "@/app/(admin)/catalog-sync/_lib/outcome-copy";

/**
 * `describeCreateContentOutcome` is the single place that turns every
 * `createContentFromSourceItem` outcome (`@/server/content-creation`, Codex
 * territory — consumed only through its exported `CreateContentResult` type
 * here, never imported directly) into operator-facing copy. The P0-S13 task
 * brief requires that no classification the service can return is silently
 * swallowed by the UI; this file is the exhaustive check that every one of
 * them gets its own distinct title, and that the fields carried on the
 * "why" outcomes (locale_conflict, slug_unhealthy, slug_conflict_exhausted,
 * template_render_failed) actually surface in the copy rather than being
 * dropped.
 *
 * One fixture per outcome, taken verbatim from
 * `src/server/content-creation/service.ts`'s `CreateContentResult` union so
 * a new/renamed outcome there is a type error here before it is ever a
 * silent gap in the dialog.
 */

const CREATED: CreateContentResult = {
  outcome: "created",
  novelId: "novel-1",
  novelBusinessId: "biz-001",
  articleId: "article-1",
  locale: "en",
  novelSlug: "the-novel",
  articleSlug: "the-novel-article",
  publicPageShortId: "abc123",
};

const ALREADY_EXISTS: CreateContentResult = { ...CREATED, outcome: "already_exists" };

const FIXTURES: readonly CreateContentResult[] = [
  CREATED,
  ALREADY_EXISTS,
  { outcome: "dry_run", plan: { locale: "en", title: "T", novelSlug: "t", articleSlug: "t-a", provisionalPublicPageShortId: "zzz999" } },
  { outcome: "source_item_not_found" },
  { outcome: "source_item_deleted" },
  { outcome: "source_item_ignored" },
  { outcome: "source_item_stale" },
  { outcome: "source_item_inconsistent_state" },
  {
    outcome: "locale_conflict",
    reason: "source_item_already_linked_to_different_locale",
    existingNovelId: "novel-9",
    existingLocale: "ja",
  },
  { outcome: "slug_unhealthy", field: "novel", baseSlug: "" },
  { outcome: "slug_conflict_exhausted", field: "article", baseSlug: "duplicate-title" },
  { outcome: "concurrent_creation_conflict" },
  { outcome: "template_render_failed", code: "ERR_TEMPLATE_OUTPUT_INVALID", slot: "title", constraint: "too_long" },
];

describe("describeCreateContentOutcome · 穷举覆盖", () => {
  it("每种 outcome 都有非空标题与正文", () => {
    for (const fixture of FIXTURES) {
      const copy = describeCreateContentOutcome(fixture);
      expect(copy.title.trim().length, `${fixture.outcome} 标题为空`).toBeGreaterThan(0);
      expect(copy.body.trim().length, `${fixture.outcome} 正文为空`).toBeGreaterThan(0);
      expect(["success", "info", "warning", "danger"]).toContain(copy.tone);
    }
  });

  it("13 种 outcome 的标题互不相同——没有两种坏法共用一句话", () => {
    const titles = FIXTURES.map((fixture) => describeCreateContentOutcome(fixture).title);
    expect(new Set(titles).size).toBe(FIXTURES.length);
  });

  it("created 与 already_exists 语气不同——前者是成功，后者是幂等命中，不该看起来一样", () => {
    expect(describeCreateContentOutcome(CREATED).tone).toBe("success");
    expect(describeCreateContentOutcome(ALREADY_EXISTS).tone).toBe("info");
    expect(describeCreateContentOutcome(CREATED).title).not.toBe(
      describeCreateContentOutcome(ALREADY_EXISTS).title,
    );
  });

  it("locale_conflict 把 existingLocale 与 existingNovelId 写进正文，不是只报个代码", () => {
    const copy = describeCreateContentOutcome({
      outcome: "locale_conflict",
      reason: "source_item_already_linked_to_different_locale",
      existingNovelId: "novel-42",
      existingLocale: "ko",
    });
    expect(copy.body).toContain("ko");
    expect(copy.body).toContain("novel-42");
    expect(copy.tone).toBe("danger");
  });

  it.each(["novel", "article"] as const)(
    "slug_unhealthy(%s) 把 field 翻成中文、baseSlug 原样带出",
    (field) => {
      const copy = describeCreateContentOutcome({ outcome: "slug_unhealthy", field, baseSlug: "raw-base" });
      expect(copy.body).toContain("raw-base");
      expect(copy.body).toContain(field === "novel" ? "书目" : "文章");
    },
  );

  it("slug_conflict_exhausted 同样带出 field 与 baseSlug", () => {
    const copy = describeCreateContentOutcome({
      outcome: "slug_conflict_exhausted",
      field: "article",
      baseSlug: "popular-title",
    });
    expect(copy.body).toContain("popular-title");
    expect(copy.body).toContain("文章");
  });

  it("template_render_failed 带出 code/slot/constraint，且三者都是可选的", () => {
    const full = describeCreateContentOutcome({
      outcome: "template_render_failed",
      code: "ERR_TEMPLATE_OUTPUT_INVALID",
      slot: "title",
      constraint: "too_long",
    });
    expect(full.body).toContain("ERR_TEMPLATE_OUTPUT_INVALID");
    expect(full.body).toContain("title");
    expect(full.body).toContain("too_long");

    const codeOnly = describeCreateContentOutcome({
      outcome: "template_render_failed",
      code: "ERR_TEMPLATE_FIELD_NOT_REGISTERED",
    });
    expect(codeOnly.body).toContain("ERR_TEMPLATE_FIELD_NOT_REGISTERED");
    expect(codeOnly.body).not.toContain("undefined");
  });

  it("concurrent_creation_conflict 措辞提示可重试，不是终局失败", () => {
    const copy = describeCreateContentOutcome({ outcome: "concurrent_creation_conflict" });
    expect(copy.tone).toBe("warning");
    expect(copy.body).toContain("重试");
  });

  it("source_item_ignored / stale 是 warning，not_found / deleted / inconsistent_state 是 danger", () => {
    expect(describeCreateContentOutcome({ outcome: "source_item_ignored" }).tone).toBe("warning");
    expect(describeCreateContentOutcome({ outcome: "source_item_stale" }).tone).toBe("warning");
    expect(describeCreateContentOutcome({ outcome: "source_item_not_found" }).tone).toBe("danger");
    expect(describeCreateContentOutcome({ outcome: "source_item_deleted" }).tone).toBe("danger");
    expect(describeCreateContentOutcome({ outcome: "source_item_inconsistent_state" }).tone).toBe(
      "danger",
    );
  });
});
