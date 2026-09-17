import Link from "next/link";

import { Container } from "@/components/Container";
import { SiteShell, type SiteChrome } from "@/features/public-ui/layout/SiteShell";
import type { BlogCardView } from "@/lib/site/blog-queries";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";

/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
 * `/blog` list page. Deliberately its own screen rather than reusing
 * `CollectionScreen`/`BookGrid` — those are typed to `NovelCardView`
 * (`features/public-ui/types.ts`'s own header freezes that type as
 * Novel-shaped, with an explicit field ban list for upstream-distribution
 * concepts that make no sense for a locally-authored blog post: no cover
 * requirement, no tags, no locale badge, a publish date instead). A text
 * list, not a cover-grid, matches CPS's own blog list layout shape and
 * this round's "保持最小" discipline — no new card component family
 * beyond what `/blog` actually needs.
 */
export function BlogListScreen({
  locale,
  posts,
  chrome,
}: {
  locale: SiteLocale;
  posts: readonly BlogCardView[];
  chrome?: SiteChrome;
}) {
  const t = getPublicT(locale);

  return (
    <SiteShell locale={locale} chrome={chrome}>
      <Container>
        <header className="border-b border-novel-border pt-12 pb-8 md:pt-20 md:pb-10">
          <h1 className="font-novel-serif text-3xl leading-tight font-semibold tracking-tight text-balance text-novel-fg md:text-[2.5rem]">
            {t("blog.listTitle")}
          </h1>
          <p className="mt-4 max-w-[60ch] text-base text-novel-fg-muted">{t("blog.listDescription")}</p>
        </header>

        <div className="pt-10 md:pt-14">
          {posts.length === 0 ? (
            <p className="py-16 text-center text-novel-fg-subtle" data-testid="blog-list-empty">
              {t("blog.empty")}
            </p>
          ) : (
            <ul className="divide-y divide-novel-border" data-testid="blog-list">
              {posts.map((post) => (
                <li key={post.id} className="py-8 first:pt-0">
                  <article>
                    <Link href={post.href} className="group block focus-visible:outline-offset-4">
                      <h2 className="font-novel-serif text-xl leading-snug font-medium text-novel-fg group-hover:underline md:text-2xl">
                        {post.title}
                      </h2>
                      <time
                        dateTime={post.publishedAt.toISOString()}
                        className="mt-2 block text-sm text-novel-fg-subtle tabular-nums"
                      >
                        {post.publishedAt.toISOString().slice(0, 10)}
                      </time>
                      {post.summary ? (
                        <p className="mt-3 line-clamp-3 max-w-[68ch] text-base leading-relaxed text-novel-fg-muted">
                          {post.summary}
                        </p>
                      ) : null}
                    </Link>
                  </article>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Container>
    </SiteShell>
  );
}
