import { Container } from "@/components/Container";
import { SiteShell, type SiteChrome } from "@/features/public-ui/layout/SiteShell";
import type { BlogDetailView } from "@/lib/site/blog-queries";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";

/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
 * `/blog/{slug}` detail page. `post.body` is pre-sanitized HTML
 * (`src/server/articles/sanitize-body.ts`, written at admin save time) —
 * same `dangerouslySetInnerHTML` posture `NovelDetailScreen` already uses
 * for `novel.contentBody`, not a new trust boundary.
 */
export function BlogDetailScreen({
  locale,
  post,
  chrome,
}: {
  locale: SiteLocale;
  post: BlogDetailView;
  chrome?: SiteChrome;
}) {
  const t = getPublicT(locale);

  return (
    <SiteShell locale={locale} chrome={chrome}>
      <Container>
        <article className="pt-10 pb-16 md:pt-16">
          <header className="mx-auto max-w-[68ch]">
            <h1 className="font-novel-serif text-3xl leading-[1.15] font-semibold tracking-tight text-balance text-novel-fg md:text-[2.5rem]">
              {post.title}
            </h1>
            <time
              dateTime={post.publishedAt.toISOString()}
              className="mt-4 block text-sm text-novel-fg-subtle tabular-nums"
            >
              {t("blog.publishedOn", { date: post.publishedAt.toISOString().slice(0, 10) })}
            </time>
            {post.summary ? (
              <p className="mt-6 text-lg leading-relaxed text-novel-fg-muted">{post.summary}</p>
            ) : null}
          </header>

          <div
            className="prose prose-neutral mx-auto mt-10 max-w-[68ch]"
            data-testid="blog-body"
            dangerouslySetInnerHTML={{ __html: post.body }}
          />
        </article>
      </Container>
    </SiteShell>
  );
}
