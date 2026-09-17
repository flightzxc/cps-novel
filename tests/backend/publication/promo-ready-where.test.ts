/**
 * Batch-create-operator-ux foundation step: guard test proving
 * `readyPromoLinkWhere` (the SQL-level pre-filter used by
 * `src/server/content-creation/eligibility.ts`'s `novelWhere` to compute an
 * exact-ish COUNT(*) for the batch-generate page) stays aligned with
 * `isPromoReady` (the authoritative, trim-checking predicate).
 *
 * This test interprets the ACTUAL object `readyPromoLinkWhere()` returns —
 * not a hand-copied re-description of it — against each fixture, using a
 * small generic Prisma-`where` evaluator (`equals`/`not`/`OR`/`AND`/`NOT`).
 * That means it goes red if either implementation changes alone: change
 * `isPromoReady`'s trim/status logic and a fixture's expected boolean stops
 * matching; change `readyPromoLinkWhere`'s shape (e.g. drop `deletedAt`,
 * swap `OR` for `AND`, typo a field name) and the interpreter's verdict for
 * a fixture flips independently of `isPromoReady`.
 *
 * One fixture — whitespace-only URL — is a KNOWN, DELIBERATE gap: Prisma's
 * typed query API has no trim/regex string predicate, and a relation filter
 * (`promoLinks: { some }`) cannot embed raw SQL without dropping the whole
 * host query to `$queryRaw` (see `readyPromoLinkWhere`'s own doc comment in
 * `src/server/publication/visibility.ts` for why, and for the precedent —
 * `src/lib/seo/sitemap.ts`'s `activePublicArticleWhere` already accepts the
 * identical gap for the identical field pair). That fixture is asserted to
 * DISAGREE, on purpose, rather than silently equality-asserted like the
 * rest — if someone makes `readyPromoLinkWhere` trim-exact (or a raw-SQL
 * variant) and this test starts failing on that assertion, that's a real
 * improvement this test should then be updated to reflect, not a false
 * alarm.
 */
import { describe, expect, it } from "vitest";

import { isPromoReady, readyPromoLinkWhere, type PromoLinkReadinessState } from "@/server/publication/visibility";

type PromoLinkFixture = {
  status: string;
  webUrl: string | null;
  appUrl: string | null;
  deletedAt: Date | null;
};

type WhereCondition = Record<string, unknown>;

function matchesScalar(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null;
  if (typeof condition === "object" && condition !== null && !Array.isArray(condition)) {
    const cond = condition as { equals?: unknown; not?: unknown };
    // SQL three-valued logic: a NULL column never satisfies `<> x` (nor
    // `= x`) — it compares UNKNOWN either way, which a WHERE clause treats
    // as "does not match". Prisma's `{ not: "" }` compiles to that exact
    // `<> ''` SQL, so a null value must resolve to `false` here too, not
    // `null !== cond.not` (which JS would otherwise evaluate as `true`).
    if ("not" in cond) return value !== null && value !== cond.not;
    if ("equals" in cond) return value === cond.equals;
  }
  return value === condition;
}

/** Minimal generic Prisma-`where` interpreter — only the operators `readyPromoLinkWhere` actually uses. */
function matchesWhere(row: PromoLinkFixture, where: WhereCondition): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as WhereCondition[]).some((c) => matchesWhere(row, c));
    if (key === "AND") return (condition as WhereCondition[]).every((c) => matchesWhere(row, c));
    if (key === "NOT") return !matchesWhere(row, condition as WhereCondition);
    return matchesScalar((row as unknown as Record<string, unknown>)[key], condition);
  });
}

function fixture(overrides: Partial<PromoLinkFixture> = {}): PromoLinkFixture {
  return { status: "fetched", webUrl: "https://example.test/ready", appUrl: null, deletedAt: null, ...overrides };
}

function asReadinessState(row: PromoLinkFixture): PromoLinkReadinessState {
  return { status: row.status, webUrl: row.webUrl, appUrl: row.appUrl };
}

const WHERE = readyPromoLinkWhere();

describe("readyPromoLinkWhere agrees with isPromoReady", () => {
  const agreeingFixtures: Array<{ name: string; row: PromoLinkFixture; expected: boolean }> = [
    { name: "status not fetched", row: fixture({ status: "pending" }), expected: false },
    { name: "both URLs null", row: fixture({ webUrl: null, appUrl: null }), expected: false },
    { name: "both URLs empty string", row: fixture({ webUrl: "", appUrl: "" }), expected: false },
    { name: "only webUrl set", row: fixture({ webUrl: "https://a.example/", appUrl: null }), expected: true },
    { name: "only appUrl set", row: fixture({ webUrl: null, appUrl: "app://a" }), expected: true },
    { name: "normal ready row", row: fixture(), expected: true },
  ];

  it.each(agreeingFixtures)("$name: isPromoReady and the SQL predicate agree ($expected)", ({ row, expected }) => {
    expect(isPromoReady(asReadinessState(row))).toBe(expected);
    expect(matchesWhere(row, WHERE)).toBe(expected);
  });

  it("deleted-but-otherwise-ready is excluded at the SQL layer — `isPromoReady` itself is not deletion-aware", () => {
    // `isPromoReady`'s own type (`PromoLinkReadinessState`) carries no
    // `deletedAt` field at all — deletion is filtered upstream of it
    // everywhere it is called (`resolveReadyPromoLinksForNovels`'s query:
    // `where: { deletedAt: null, status: "fetched" }`,
    // `article-rebind/guards.ts`'s `resolveTargetPromoLink` query), so
    // `isPromoReady` never actually receives a soft-deleted row in the real
    // pipeline. This is therefore a `readyPromoLinkWhere`-only assertion,
    // not an isPromoReady-agreement one.
    const row = fixture({ deletedAt: new Date("2026-01-01T00:00:00.000Z") });
    expect(matchesWhere(row, WHERE)).toBe(false);
  });

  it("absent PromoLink (no row at all) is not ready — not a row-level `matchesWhere` question", () => {
    // `readyPromoLinkWhere` is only meaningful nested under `promoLinks: { some: ... }`;
    // a Novel with zero PromoLink rows can never satisfy `some`, matching
    // `isPromoReady(null) === false` at the relational level (exercised
    // below in the "relation-level" describe block).
    expect(isPromoReady(null)).toBe(false);
  });

  it("KNOWN GAP (documented, accepted): whitespace-only webUrl — SQL predicate is a permissive superset", () => {
    const row = fixture({ webUrl: "   ", appUrl: null });
    // Authoritative: isPromoReady trims and correctly reports this as blank.
    expect(isPromoReady(asReadinessState(row))).toBe(false);
    // SQL pre-filter: `not: ""` does not trim, so a whitespace-only string
    // still counts as "not empty" and the row matches. This is the exact,
    // deliberately accepted gap documented on `readyPromoLinkWhere` — if
    // this assertion ever flips to `false` because someone made the
    // predicate trim-exact, update this test's expectation (and its
    // preceding comment) rather than treating the flip as a regression.
    expect(matchesWhere(row, WHERE)).toBe(true);
  });

  it("KNOWN GAP still resolves correctly end to end: the admission classifier remains authoritative", () => {
    // Even though the whitespace-only row above would be counted into the
    // SQL-level "generatable" bucket (a listing/counting optimisation
    // only), `resolveArticleGenerateAdmissions` calls `isPromoReady`
    // per-row (via `pickReadyPromoLink`) and would still correctly refuse
    // to admit it — see `src/server/article-rebind/guards.ts`'s
    // `pickReadyPromoLink` and this repo's own
    // `tests/backend/publication/promo-whitespace-boundaries.test.ts` for
    // the equivalent end-to-end proof at the publish/sitemap/IndexNow
    // boundaries.
    const row = fixture({ webUrl: "   ", appUrl: null });
    expect(isPromoReady(asReadinessState(row))).toBe(false);
  });
});

describe("readyPromoLinkWhere at the relation level (promoLinks: { some/none })", () => {
  function matchesSomeReady(links: readonly PromoLinkFixture[]): boolean {
    return links.some((link) => matchesWhere(link, WHERE));
  }

  it("a Novel with zero PromoLink rows never matches `some`", () => {
    expect(matchesSomeReady([])).toBe(false);
  });

  it("a Novel with only a not-ready PromoLink does not match `some`", () => {
    expect(matchesSomeReady([fixture({ webUrl: null, appUrl: null })])).toBe(false);
  });

  it("a Novel with one ready PromoLink among several matches `some`", () => {
    expect(matchesSomeReady([
      fixture({ status: "pending" }),
      fixture({ deletedAt: new Date("2026-01-01T00:00:00.000Z") }),
      fixture(),
    ])).toBe(true);
  });

  it("NOT { some } (the non-generatable bucket) excludes a Novel that has a ready link", () => {
    const links = [fixture()];
    expect(!matchesSomeReady(links)).toBe(false);
  });

  it("NOT { some } includes a Novel whose only links are deleted/not-ready", () => {
    const links = [fixture({ deletedAt: new Date("2026-01-01T00:00:00.000Z") }), fixture({ webUrl: null, appUrl: null })];
    expect(!matchesSomeReady(links)).toBe(true);
  });
});

/**
 * A byte-exact confirmation that Postgres itself evaluates `not: ""` and
 * `isPromoReady` the same way this file's in-memory interpreter predicts
 * (including the documented whitespace gap) would need a real Postgres
 * round-trip. `tests/integration/` is this repo's home for that
 * (`tests/integration/README.md`: "Owner: Codex（独占写入）") and is out of
 * scope for this lane to write into — NOT RUN here. This file's in-memory
 * interpreter is a faithful reading of the Prisma operators
 * `readyPromoLinkWhere` actually uses (`equals`/`not`/`OR`/`AND`/`NOT`,
 * which Prisma translates to plain SQL comparison/boolean operators with no
 * further magic), so the risk of the interpreter itself silently drifting
 * from Postgres semantics is low, but it is not the same thing as running
 * against a live database.
 */
describe.todo("real-Postgres round-trip for readyPromoLinkWhere (NOT RUN — belongs in tests/integration/, Codex-owned)");
