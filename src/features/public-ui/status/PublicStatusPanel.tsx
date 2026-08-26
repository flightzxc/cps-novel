import { ButtonLink } from "@/components/Button";
import { Container } from "@/components/Container";

/**
 * Headless status panel: serif title, muted body, outline home link.
 *
 * Shared visual language for unavailable screens, the root 404, and the
 * public error boundary. Does not render SiteShell — root not-found / error
 * have no chrome data to feed a header or footer.
 */
export function PublicStatusPanel({
  title,
  body,
  homeHref = "/",
  homeLabel,
  eyebrow,
  testId = "public-status-panel",
  reason,
  bare = false,
}: {
  title: string;
  body: string;
  homeHref?: string;
  homeLabel: string;
  eyebrow?: string;
  testId?: string;
  reason?: string;
  /** Full-viewport dark canvas when there is no SiteShell around this panel. */
  bare?: boolean;
}) {
  const panel = (
    <Container>
      <div
        className="flex min-h-[46vh] flex-col items-start justify-center py-20 md:py-28"
        data-testid={testId}
        {...(reason ? { "data-unavailable-reason": reason } : {})}
      >
        <div className="max-w-[52ch]">
          {eyebrow ? (
            <p className="font-novel-serif text-base text-novel-fg-subtle">{eyebrow}</p>
          ) : null}

          <h1 className="mt-3 font-novel-serif text-2xl leading-tight font-semibold tracking-tight text-novel-fg md:text-4xl">
            {title}
          </h1>

          <p className="mt-5 text-base leading-relaxed text-novel-fg-muted">{body}</p>

          <ButtonLink href={homeHref} variant="outline" size="lg" className="mt-10">
            {homeLabel}
          </ButtonLink>
        </div>
      </div>
    </Container>
  );

  if (!bare) return panel;

  return <div className="min-h-screen bg-novel-bg">{panel}</div>;
}
