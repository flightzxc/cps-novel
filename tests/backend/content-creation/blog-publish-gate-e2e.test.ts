/**
 * C-28 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-28):
 * "tests/backend/publish-gate/: 新建的博客草稿能通过门禁发布（C-27 已铺路，
 * 此处是端到端确认）". Same shape and scope discipline as this directory's
 * own `publish-gate-e2e.test.ts` (P0-S9's novel-article equivalent) —
 * co-located here rather than under `tests/backend/publish-gate/` for the
 * same reason that file already is: this is fundamentally a property of
 * `src/server/content-creation/`'s own output (does what it creates clear
 * the *real*, unmodified `evaluatePublishGate`?), not a test of the
 * evaluator's own internals (those live in
 * `tests/backend/publish-gate/evaluator.test.ts`).
 *
 * Builds the `PublishGateFacts` snapshot by hand from the created row's
 * fields, same "stub the DB-assembly step, exercise the real classifier
 * unmodified" split `publish-gate-e2e.test.ts` already uses — extending a
 * fake to also satisfy `loadPublishGateFacts`'s Prisma call shape would be a
 * second, unrelated fake-DB surface this task does not need.
 */
import { describe, expect, it } from "vitest";

import { createBlogArticle } from "@/server/content-creation/blog";
import { evaluatePublishGate, type PublishGateFacts } from "@/server/publish-gate";

import { FakeBlogArticleDb } from "./blog-fake-db";

const ADMIN_ACTOR = { type: "admin", adminId: "admin-1" } as const;
const ENABLED = { FEATURE_ARTICLE_BLOG: "true", ARTICLE_BLOG_ALLOW_WRITE: "true" } as unknown as NodeJS.ProcessEnv;

describe("C-28 end-to-end: blog creation → real evaluatePublishGate", () => {
  it("a freshly created blog draft is immediately publishable — none of the five Novel-side reasons apply, and rights_blocked correctly does not fire for a draft", async () => {
    const fake = new FakeBlogArticleDb();
    const result = await createBlogArticle(
      fake.asPrismaClient(),
      {
        locale: "en",
        title: "A Blog Post About Novels",
        slug: "a-blog-post-about-novels",
        body: "<p>Real content, not a fixture stand-in.</p>",
        seoVisibility: "public",
        actor: ADMIN_ACTOR,
        requestId: "req-blog-e2e-1",
      },
      ENABLED,
    );
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");

    const article = fake.articles.find((row) => row.id === result.articleId);
    if (!article) throw new Error("unreachable");
    // Sanity: this really is the C-27 shape — no Novel, no PromoLink, no
    // Template, and status is the column default ("draft"), never spelled
    // by the creation service (see `no-bypass.test.ts`).
    expect(article.novelId).toBeNull();
    expect(article.templateId).toBeNull();
    expect(article.promoLinkId).toBeNull();
    expect(article.articleType).toBe("blog_article");

    const facts: PublishGateFacts = {
      // C-27: `facts.novel === null` is the evaluator's fork signal for a
      // non-`novel_article` — a real `loadPublishGateFacts` call would
      // produce exactly this for a blog Article (see that module's own
      // header on why).
      novel: null,
      article: { status: "draft", locale: article.locale, title: article.title, slug: article.slug, body: article.body },
      // A blog Article has no PromoLink/preview chapters by construction —
      // modeled here as absent, matching what a real DB row for one looks
      // like today (this creation service never touches either).
      promoLink: null,
      preview: { hasPreviewChapter: false, hasPreviewBody: false },
      pageIdentity: { conflicting: false },
    };

    const evaluation = evaluatePublishGate(facts);

    // The whole point of the C-27→C-28 pipeline: none of the five
    // Novel-side reasons (preview_chapter_missing/preview_body_missing/
    // promo_link_missing/promo_link_not_ready/rights_blocked) fire for this
    // Novel-less, non-takedown draft — only the three (four, post-M-1)
    // Article-level conditions apply, and all of them pass for a row this
    // service just created.
    expect(evaluation.reasons).toEqual([]);
    expect(evaluation.requiredMetadataMissing).toBeNull();
    expect(evaluation.publishable).toBe(true);
  });

  it("(control) the same facts with body forced back to '' — proving the gate genuinely reacts to the blog's own body, not a fixture artifact", () => {
    const blankBodyFacts: PublishGateFacts = {
      novel: null,
      article: { status: "draft", locale: "en", title: "Title", slug: "slug", body: "" },
      promoLink: null,
      preview: { hasPreviewChapter: false, hasPreviewBody: false },
      pageIdentity: { conflicting: false },
    };
    const evaluation = evaluatePublishGate(blankBodyFacts);
    expect(evaluation.reasons).toContain("required_metadata_missing");
    expect(evaluation.requiredMetadataMissing).toEqual({
      reason: "required_metadata_missing",
      missingFields: ["body"],
    });
    expect(evaluation.publishable).toBe(false);
  });

  it("(control) a takedown blog does NOT clear the gate — M-1's Article-side rights_blocked fires", () => {
    const facts: PublishGateFacts = {
      novel: null,
      article: { status: "takedown", locale: "en", title: "Title", slug: "slug", body: "Body" },
      promoLink: null,
      preview: { hasPreviewChapter: false, hasPreviewBody: false },
      pageIdentity: { conflicting: false },
    };
    const evaluation = evaluatePublishGate(facts);
    expect(evaluation.reasons).toEqual(["rights_blocked"]);
    expect(evaluation.publishable).toBe(false);
  });
});
