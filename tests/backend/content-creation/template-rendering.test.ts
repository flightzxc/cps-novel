/**
 * P0-S9: wiring-level tests for the Template Engine → `createContentFromSourceItem`
 * connection (`src/server/content-creation/service.ts`). Distinct from
 * `default-article-template.test.ts` (pure, DB-free) and
 * `service.test.ts`'s general success-path assertions: this file is
 * specifically about (a) graceful degradation when the optional template
 * fields have no data yet, and (b) the HTML-safety boundary — proving that
 * hostile *data* (a `NovelSourceItem`'s upstream-sourced title/description/
 * coverUrl, which this service does not otherwise validate) cannot break out
 * of `DEFAULT_ARTICLE_TEMPLATE`'s fixed HTML structure once it reaches
 * `Article.body`. `DEFAULT_ARTICLE_TEMPLATE` itself is a fixed, code-literal
 * template (not admin-authored), so "malicious template" in this codebase's
 * P2-02 threat model narrows here to "malicious values interpolated into a
 * safe template" — the two P2-02 hardening commits
 * (`389e8d0`/`e4ce6f5`, see `docs/p2/P2_02_TEMPLATE_ENGINE.md` §1.3) are
 * exactly what stands between that upstream data and a stored XSS in
 * `Article.body`, so this suite is the integration-level proof that they are
 * actually reachable through this write path, not just exercised in
 * isolation by `tests/ui/template-engine.test.ts`'s 87 unit tests.
 */
import { describe, expect, it } from "vitest";

import { createContentFromSourceItem } from "@/server/content-creation/service";

import { FakeContentCreationDb } from "./fake-db";

const ADMIN_ACTOR = { type: "admin", adminId: "admin-1" } as const;

describe("template rendering wiring — graceful degradation", () => {
  it("omits the cover image entirely when NovelSourceItem.coverUrl is null (no PromoLink/cover data yet)", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({
      title: "No Cover Yet",
      description: "This novel has no cover image on file.",
      coverUrl: null,
    });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-nocover",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    const article = fake.articles.get(result.articleId);
    expect(article?.body).not.toBe("");
    expect(article?.body).not.toContain("<img");
    expect(article?.body).toContain("<h1>No Cover Yet</h1>");
  });

  it("omits the promo call-to-action entirely — no PromoLink exists at S9's point in the pipeline (S5's territory)", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "No Promo Link Yet", description: "Description." });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-nopromo",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    const article = fake.articles.get(result.articleId);
    expect(article?.body).not.toContain("<a href");
    expect(article?.body).not.toContain("Start Reading");
    // And the row is still a perfectly normal draft — no PromoLink, no status bypass.
    expect(fake.lastArticleCreateArgs).not.toHaveProperty("promoLinkId");
  });
});

describe("template rendering wiring — HTML safety boundary (P2-02 fix commits 389e8d0 / e4ce6f5)", () => {
  it("HTML-escapes a <script>-bearing title/description in the rendered body text nodes, never emitting a live tag", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({
      title: `<script>alert(1)</script> "Title"`,
      description: `A "cool" <b>book</b> & more`,
    });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-xss-1",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    const article = fake.articles.get(result.articleId);

    // The raw hostile substrings must never appear verbatim in the stored HTML.
    expect(article?.body).not.toContain("<script>alert(1)</script>");
    expect(article?.body).not.toContain("<b>book</b>");
    // Entity-escaped equivalents must appear instead.
    expect(article?.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(article?.body).toContain("&quot;Title&quot;");
    expect(article?.body).toContain("A &quot;cool&quot; &lt;b&gt;book&lt;/b&gt; &amp; more");

    // `title`/`metaTitle`/`metaDescription` are the engine's "text" slots —
    // frozen by P2-02 contract to stay unescaped plain text (they are never
    // fed through dangerouslySetInnerHTML downstream; React/Next own the
    // escaping for those). Confirming this stays raw is a guard against
    // someone "fixing" that asymmetry locally in a way that would silently
    // double-escape metadata everywhere it's consumed as plain text.
    expect(article?.title).toBe(`<script>alert(1)</script> "Title"`);
  });

  it("rejects (does not write) a javascript: scheme coverUrl instead of emitting it into img[src]", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({
      title: "Safe Title",
      description: "Safe description.",
      coverUrl: "javascript:alert(1)",
    });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-xss-2",
    });

    expect(result.outcome).toBe("template_render_failed");
    if (result.outcome !== "template_render_failed") throw new Error("unreachable");
    expect(result.code).toBe("ERR_TEMPLATE_VALUE_INVALID");
    expect(result.slot).toBe("body");
    expect(result.constraint).toBe("absolute_url");

    // Nothing was left behind: the Novel this attempt inserted before hitting
    // the render step must be rolled back, not orphaned.
    expect(fake.novels.size).toBe(0);
    expect(fake.articles.size).toBe(0);
    // The source item is untouched — safe to retry once the upstream data is fixed.
    const stillPending = fake.sourceItems.get(sourceItem.id);
    expect(stillPending?.novelId).toBeNull();
    expect(stillPending?.status).toBe("pending");
  });

  it("rejects a coverUrl attempting attribute-quote breakout (a literal '\"' in the value)", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({
      title: "Safe Title",
      description: "Safe description.",
      coverUrl: 'https://example.com/cover.jpg" onerror="alert(1)',
    });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-xss-3",
    });

    expect(result.outcome).toBe("template_render_failed");
    if (result.outcome !== "template_render_failed") throw new Error("unreachable");
    expect(result.code).toBe("ERR_TEMPLATE_VALUE_INVALID");
    expect(result.constraint).toBe("absolute_url");
    expect(fake.novels.size).toBe(0);
  });

  it("fails closed (never writes a half-filled draft) when NovelSourceItem.description is whitespace-only", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({
      title: "Has A Title",
      description: "   ",
    });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-blank-desc",
    });

    expect(result.outcome).toBe("template_render_failed");
    if (result.outcome !== "template_render_failed") throw new Error("unreachable");
    expect(result.code).toBe("ERR_TEMPLATE_VAR_EMPTY");
    expect(result.slot).toBe("body");
    // No orphaned Novel row, and the source item is still retry-safe.
    expect(fake.novels.size).toBe(0);
    expect(fake.sourceItems.get(sourceItem.id)?.status).toBe("pending");
  });
});
