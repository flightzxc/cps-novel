import { Button, ButtonLink } from "@/components/Button";
import { Container } from "@/components/Container";

/**
 * Headless status panel: serif title, muted body, outline home link.
 *
 * Shared visual language for unavailable screens, the root 404, and the
 * public error boundary. Does not render SiteShell — root not-found / error
 * have no chrome data to feed a header or footer, and the brand slot is still
 * the `BRAND_PLACEHOLDER` text, which must not ship on a public error page.
 * Registered as an exception to the P1-10 §12 status-page form.
 *
 * `min-h-[46vh]` only applies inside a SiteShell, where the header and footer
 * take up the rest of the viewport. `bare` has neither, so it centres on the
 * viewport instead — reusing 46vh there would leave the lower half empty.
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
  retryLabel,
  onRetry,
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
  /** Retry is the paper action when present; going home stays the outline one. */
  retryLabel?: string;
  onRetry?: () => void;
}) {
  const panel = (
    <Container>
      <div
        className={`flex flex-col items-start justify-center py-20 md:py-28 ${bare ? "" : "min-h-[46vh]"}`}
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

          <div className="mt-10 flex flex-wrap items-center gap-3">
            {retryLabel && onRetry ? (
              <Button variant="accent" size="lg" onClick={onRetry}>
                {retryLabel}
              </Button>
            ) : null}
            <ButtonLink href={homeHref} variant="outline" size="lg">
              {homeLabel}
            </ButtonLink>
          </div>
        </div>
      </div>
    </Container>
  );

  if (!bare) return panel;

  return <div className="flex min-h-screen flex-col justify-center bg-novel-bg">{panel}</div>;
}
