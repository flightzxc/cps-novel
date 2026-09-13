import { describe, expect, it } from "vitest";

import { DEFAULT_ARTICLE_TEMPLATE } from "@/server/content-creation/default-article-template";
import { generateArticleFromNovel } from "@/server/content-creation/generate";

import { FakeContentCreationDb } from "./fake-db";

const ADMIN_ACTOR = { type: "admin", adminId: "admin-1" } as const;

function seedGenerateReady(
  fake: FakeContentCreationDb,
  novelFields: { title: string; description?: string; coverUrl?: string | null },
) {
  const novel = fake.seedNovel({
    title: novelFields.title,
    description: novelFields.description ?? "A sample description.",
    coverUrl: novelFields.coverUrl === undefined ? null : novelFields.coverUrl,
    locale: "en",
    slug: "wired-novel",
  });
  const promo = fake.seedPromoLink({ novelId: novel.id, publicRedirectCode: "goabc123" });
  fake.seedArticleTemplate({
    templateKey: "system-default-v1",
    locale: "en",
    status: "active",
    bodyTemplate: DEFAULT_ARTICLE_TEMPLATE.body,
    seoTemplate: {
      title: DEFAULT_ARTICLE_TEMPLATE.title,
      metaTitle: DEFAULT_ARTICLE_TEMPLATE.metaTitle,
      metaDescription: DEFAULT_ARTICLE_TEMPLATE.metaDescription,
    },
  });
  return { novel, promo };
}

describe("template rendering wiring — graceful degradation", () => {
  it("omits the cover image entirely when Novel.coverUrl is null", async () => {
    const fake = new FakeContentCreationDb();
    const { novel } = seedGenerateReady(fake, {
      title: "No Cover Yet",
      description: "This novel has no cover image on file.",
      coverUrl: null,
    });

    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id,
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

  it("renders the bound promo redirect, not a missing CTA", async () => {
    const fake = new FakeContentCreationDb();
    const { novel, promo } = seedGenerateReady(fake, { title: "Promo Ready Novel", description: "Description." });

    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-promo",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    const article = fake.articles.get(result.articleId);
    expect(article?.body).toContain(`href="/go/${promo.publicRedirectCode}"`);
    expect(article?.body).toContain("Start Reading");
    expect(fake.lastArticleCreateArgs).toMatchObject({ promoLinkId: promo.id });
  });
});

describe("template rendering wiring — HTML safety boundary", () => {
  it("HTML-escapes a <script>-bearing title/description in the rendered body text nodes", async () => {
    const fake = new FakeContentCreationDb();
    const { novel } = seedGenerateReady(fake, {
      title: `<script>alert(1)</script> "Title"`,
      description: `A "cool" <b>book</b> & more`,
    });

    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-xss-1",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    const article = fake.articles.get(result.articleId);
    expect(article?.body).not.toContain("<script>alert(1)</script>");
    expect(article?.body).not.toContain("<b>book</b>");
    expect(article?.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(article?.body).toContain("&quot;Title&quot;");
    expect(article?.body).toContain("A &quot;cool&quot; &lt;b&gt;book&lt;/b&gt; &amp; more");
    expect(article?.title).toBe(`<script>alert(1)</script> "Title"`);
  });

  it("rejects a javascript: coverUrl instead of emitting it into img[src]", async () => {
    const fake = new FakeContentCreationDb();
    const { novel } = seedGenerateReady(fake, {
      title: "Safe Title",
      description: "Safe description.",
      coverUrl: "javascript:alert(1)",
    });

    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-xss-2",
    });

    expect(result.outcome).toBe("template_render_failed");
    if (result.outcome !== "template_render_failed") throw new Error("unreachable");
    expect(result.code).toBe("ERR_TEMPLATE_VALUE_INVALID");
    expect(fake.articles.size).toBe(0);
    expect(fake.novels.size).toBe(1);
  });

  it("rejects a coverUrl attempting attribute-quote breakout", async () => {
    const fake = new FakeContentCreationDb();
    const { novel } = seedGenerateReady(fake, {
      title: "Safe Title",
      description: "Safe description.",
      coverUrl: 'https://example.com/cover.jpg" onerror="alert(1)',
    });

    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-xss-3",
    });

    expect(result.outcome).toBe("template_render_failed");
    expect(fake.articles.size).toBe(0);
    expect(fake.novels.size).toBe(1);
  });

  it("fails closed when Novel.description is whitespace-only", async () => {
    const fake = new FakeContentCreationDb();
    const { novel } = seedGenerateReady(fake, {
      title: "Has A Title",
      description: "   ",
    });

    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-blank-desc",
    });

    expect(result.outcome).toBe("template_render_failed");
    if (result.outcome !== "template_render_failed") throw new Error("unreachable");
    expect(result.code).toBe("ERR_TEMPLATE_VAR_EMPTY");
    expect(fake.articles.size).toBe(0);
    expect(fake.novels.size).toBe(1);
  });
});
