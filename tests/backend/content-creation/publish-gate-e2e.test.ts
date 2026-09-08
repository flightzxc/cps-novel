/**
 * P0-S9 end-to-end acceptance test: `NovelSourceItem` → `createContentFromSourceItem`
 * (`src/server/content-creation/service.ts`, now rendering `Article.body` via
 * the P2-02 Template Engine) → the *real*, unmodified
 * `evaluatePublishGate` (`src/server/publish-gate/evaluator.ts`) — proving
 * that `required_metadata_missing` no longer fires on `body` for content
 * this service creates. S9's whole mandate is "make Article.body non-blank
 * so the publish gate stops blocking on it"; this file is the test that
 * mandate lives or dies on.
 *
 * Scope discipline: this does not call `loadPublishGateFacts`
 * (`src/server/publish-gate/facts.ts`, the DB-querying half) — extending
 * `FakeContentCreationDb` to also satisfy that function's Prisma call shape
 * (a `select` with nested `novel`/`promoLink` includes plus a separate
 * `novelChapter.findMany`) would be a second, unrelated fake-DB surface for
 * a module this task does not touch. Instead this builds the
 * `PublishGateFacts` snapshot by hand from the same created row's fields and
 * feeds it to the *real* `evaluatePublishGate` — the function under test
 * (and the only one the P2-07 contract allows to decide publishability) is
 * exercised unmodified; only the DB-assembly step around it is stubbed,
 * exactly the same "pure classifier, I/O lives elsewhere" split
 * `evaluator.ts`'s own header describes.
 */
import { describe, expect, it } from "vitest";

import { createContentFromSourceItem } from "@/server/content-creation/service";
import { evaluatePublishGate, type PublishGateFacts } from "@/server/publish-gate";

import { FakeContentCreationDb } from "./fake-db";

const ADMIN_ACTOR = { type: "admin", adminId: "admin-1" } as const;

describe("P0-S9 end-to-end: content creation → real evaluatePublishGate", () => {
  it("required_metadata_missing no longer fires — the created Article's body is non-blank", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({
      title: "The Great Adventure Begins",
      description: "A sweeping tale of courage.",
      coverUrl: "https://example.com/cover.jpg",
      totalChapterCount: 42,
    });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      locale: "en",
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-e2e-1",
    });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");

    const novel = fake.novels.get(result.novelId);
    const article = fake.articles.get(result.articleId);
    if (!novel || !article) throw new Error("unreachable");

    // `FakeNovel`/`FakeArticle` don't model `status` (this fake never needed
    // it) — both columns default to `"draft"` at the schema level and this
    // service never spells a literal `status:` key (see
    // tests/backend/publish-gate/no-bypass.test.ts, which enforces exactly
    // that), so "draft" is what a real DB row would hold here too.
    const facts: PublishGateFacts = {
      novel: { status: "draft", locale: novel.locale },
      article: { status: "draft", locale: article.locale, title: article.title, slug: article.slug, body: article.body },
      // Nothing downstream of S9 has run yet: S5 (PromoLink claiming) hasn't
      // created a PromoLink, and P2-05 (preview chapter materialization)
      // hasn't materialized any preview chapters. Both are genuinely absent
      // at this point in the pipeline, not stubbed away to make the test pass.
      promoLink: null,
      preview: { hasPreviewChapter: false, hasPreviewBody: false },
      pageIdentity: { conflicting: false },
    };

    const evaluation = evaluatePublishGate(facts);

    // The one thing this task is responsible for:
    expect(evaluation.reasons).not.toContain("required_metadata_missing");
    expect(evaluation.requiredMetadataMissing).toBeNull();

    // The Article is still correctly *not* publishable overall — S9 does not
    // (and must not) touch any other gate condition. Every reason present
    // here belongs to a different, already-known, out-of-scope gap:
    //
    // - `preview_chapter_missing`: no preview chapter exists yet (P2-05's
    //   territory, untouched by S9).
    // - `promo_link_missing`: no PromoLink exists yet (S5's territory,
    //   untouched by S9 — this service never touches PromoLink at all).
    // `locale_not_publishable` no longer fires: U6 admitted `en` to
    // `PUBLISHABLE_LOCALES`.
    expect(evaluation.reasons).toEqual(["preview_chapter_missing", "promo_link_missing"]);
    expect(evaluation.publishable).toBe(false);
  });

  it("(control) the same facts with body forced back to '' — proving the gate genuinely reacts to body content, not a fixture artifact", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Control Case", description: "Control description." });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      locale: "en",
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-e2e-control",
    });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");

    const article = fake.articles.get(result.articleId);
    if (!article) throw new Error("unreachable");
    // Sanity: this run really did render a non-blank body (same as the test above).
    expect(article.body).not.toBe("");

    // Simulate S4's pre-S9 behavior (`body: ""`) to confirm the evaluator
    // would have flagged it — this is what made the P0 publish gate
    // unclearable before this task.
    const blankBodyFacts: PublishGateFacts = {
      novel: { status: "draft", locale: "en" },
      article: { status: "draft", locale: article.locale, title: article.title, slug: article.slug, body: "" },
      promoLink: null,
      preview: { hasPreviewChapter: false, hasPreviewBody: false },
      pageIdentity: { conflicting: false },
    };

    const blankEvaluation = evaluatePublishGate(blankBodyFacts);
    expect(blankEvaluation.reasons).toContain("required_metadata_missing");
    expect(blankEvaluation.requiredMetadataMissing).toEqual({
      reason: "required_metadata_missing",
      missingFields: ["body"],
    });
  });
});
