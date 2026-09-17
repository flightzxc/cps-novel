import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const grants = readFileSync(resolve(root, "infra/postgres/grants.sql"), "utf8");
const schemaSource = readFileSync(resolve(root, "prisma/schema.prisma"), "utf8");

/**
 * L10N P5.2: a real X8 uat run crashed the `scheduler` container with
 * `42501 permission denied for table article` the moment L10N P5 wired
 * `scheduler/index.ts`'s `main()` to call `queryActiveLocales(prisma)` once
 * per tick (to fan the home-carousel cron out across every active locale) --
 * `infra/postgres/grants.sql` had never been updated to give `scheduler_app`
 * any access to `article`, and `queryActiveLocales` (`src/lib/locale/
 * active-locales.ts`) builds its `WHERE` from `sitemap.ts`'s
 * `activePublicArticleWhere`, which also relation-filters through `novel`
 * and `promo_link` -- so all three tables were missing, not just one.
 *
 * The exact column lists below were not derived by reading the Prisma schema
 * and guessing which columns a `WHERE`/`JOIN` needs -- they were captured
 * from the real SQL Prisma generates for this exact call (`DEBUG=prisma:query`
 * against a live X8 postgres, using the `scheduler_app` role itself so the
 * capture matches production exactly):
 *
 *   SELECT COUNT(*) AS "_count$_all", "article"."locale"
 *   FROM "article"
 *   LEFT JOIN "novel" AS "j0" ON ("j0"."id") = ("article"."novel_id")
 *   LEFT JOIN "promo_link" AS "j1"
 *     ON ("j1"."id","j1"."novel_id") = ("article"."promo_link_id","article"."novel_id")
 *   LEFT JOIN "promo_link" AS "j2"
 *     ON ("j2"."id","j2"."novel_id") = ("article"."promo_link_id","article"."novel_id")
 *   WHERE ("article"."deleted_at" IS NULL AND "article"."status" = $1
 *     AND ("j0"."deleted_at" IS NULL AND "j0"."status" = $2 AND "j0"."id" IS NOT NULL)
 *     AND ("j1"."status" = $3 AND "j1"."id" IS NOT NULL)
 *     AND "article"."locale" IN (...)
 *     AND ("j2"."deleted_at" IS NULL AND ("j2"."web_url" <> $19 OR "j2"."app_url" <> $20) AND "j2"."id" IS NOT NULL))
 *   GROUP BY "article"."locale"
 *
 * `promo_link` is LEFT JOINed twice (once per relation filter Prisma cannot
 * merge: `PUBLIC_ARTICLE_RECORD`'s `promoLink: { is: { status: "fetched" } }`
 * and `activePublicArticleWhere`'s own extra `promoLink: { is: { deletedAt,
 * OR: [...] } }`) -- both aliases reference the same physical table and the
 * same column set, so the fix below needs one column-scoped grant, not two.
 * `seo_visibility` never appears: `docker-compose.yml`'s `scheduler` service
 * block does not pass `FEATURE_ARTICLE_SEO_VISIBILITY` at all (confirmed by
 * reading that block), so `isArticleSeoVisibilityEnabled` reads it as unset
 * and `buildPublicArticleWhere` never adds that column to the `WHERE` --
 * granting it anyway would violate the minimal-grant discipline this file
 * enforces (see the "never whole-table" test below).
 */
describe("scheduler active-locales read grants (L10N P5.2)", () => {
  const EXPECTED_ARTICLE_COLUMNS = ["locale", "deleted_at", "status", "novel_id", "promo_link_id"];
  const EXPECTED_NOVEL_COLUMNS = ["id", "deleted_at", "status"];
  const EXPECTED_PROMO_LINK_COLUMNS = ["id", "novel_id", "status", "deleted_at", "web_url", "app_url"];

  function grantedColumns(table: string): string[] | null {
    const match = grants.match(new RegExp(`GRANT SELECT \\(([^)]+)\\) ON ${table} TO scheduler_app;`));
    if (!match) return null;
    return match[1]!.split(",").map((column) => column.trim());
  }

  it("grants scheduler_app column-scoped SELECT on article covering every column the real groupBy WHERE/JOIN references", () => {
    const columns = grantedColumns("article");
    expect(columns, "expected a `GRANT SELECT (...) ON article TO scheduler_app;` line in infra/postgres/grants.sql").not.toBeNull();
    for (const column of EXPECTED_ARTICLE_COLUMNS) {
      expect(columns, `article.${column} is referenced by the captured SQL but not granted`).toContain(column);
    }
  });

  it("grants scheduler_app column-scoped SELECT on novel covering the j0 join's referenced columns", () => {
    const columns = grantedColumns("novel");
    expect(columns, "expected a `GRANT SELECT (...) ON novel TO scheduler_app;` line in infra/postgres/grants.sql").not.toBeNull();
    for (const column of EXPECTED_NOVEL_COLUMNS) {
      expect(columns, `novel.${column} is referenced by the captured SQL but not granted`).toContain(column);
    }
  });

  it("grants scheduler_app column-scoped SELECT on promo_link covering both j1/j2 joins' referenced columns", () => {
    const columns = grantedColumns("promo_link");
    expect(columns, "expected a `GRANT SELECT (...) ON promo_link TO scheduler_app;` line in infra/postgres/grants.sql").not.toBeNull();
    for (const column of EXPECTED_PROMO_LINK_COLUMNS) {
      expect(columns, `promo_link.${column} is referenced by the captured SQL but not granted`).toContain(column);
    }
  });

  it("never grants scheduler_app whole-table SELECT on article/novel/promo_link", () => {
    for (const table of ["article", "novel", "promo_link"]) {
      expect(
        grants,
        `${table} must stay column-scoped for scheduler_app -- a whole-table grant would also expose ${table === "article" ? "body/seo_metadata" : table === "novel" ? "title/description/author" : "upstream_code"}`,
      ).not.toMatch(new RegExp(`GRANT SELECT ON TABLE[^;]*\\b${table}\\b[^;]*scheduler_app`, "s"));
      expect(grants).not.toMatch(new RegExp(`GRANT SELECT ON TABLE[^;]*scheduler_app[^;]*\\b${table}\\b`, "s"));
    }
  });

  it("never grants scheduler_app INSERT/UPDATE/DELETE on article/novel/promo_link", () => {
    for (const table of ["article", "novel", "promo_link"]) {
      expect(grants, `${table} must stay read-only for scheduler_app`).not.toMatch(
        new RegExp(`GRANT[^;]*\\b(INSERT|UPDATE|DELETE)\\b[^;]*\\b${table}\\b[^;]*scheduler_app`, "s"),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Structural guard: scheduler's real (executed) Prisma read surface must stay
// inside the set of tables grants.sql actually authorizes for scheduler_app.
// ---------------------------------------------------------------------------

/** Prisma client accessor (camelCase model name) -> physical table name, parsed from `prisma/schema.prisma`'s own `@@map` declarations -- not hand-maintained, so it stays correct as the schema grows. */
function parseModelTableMap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let match: RegExpExecArray | null;
  while ((match = modelRe.exec(source))) {
    const modelName = match[1]!;
    const body = match[2]!;
    const mapMatch = body.match(/@@map\("(\w+)"\)/);
    if (!mapMatch) continue;
    const accessor = modelName.charAt(0).toLowerCase() + modelName.slice(1);
    map.set(accessor, mapMatch[1]!);
  }
  return map;
}

/** Slices out one exported `function`/`const` declaration's source text (brace-matched), so a shared file's unrelated exports (e.g. `home-carousel/service.ts`'s Worker-only `computeHomeCarouselInTx`) cannot leak spurious table references into the scan. */
function extractDeclaration(source: string, name: string): string {
  const patterns = [
    new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\(`),
    new RegExp(`export\\s+function\\s+${name}\\s*\\(`),
    new RegExp(`export\\s+const\\s+${name}\\s*[:=]`),
  ];
  let matchIndex = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match) {
      matchIndex = match.index;
      break;
    }
  }
  if (matchIndex === -1) throw new Error(`active-locales-grants.test.ts: declaration not found in scan target: ${name}`);
  const braceStart = source.indexOf("{", matchIndex);
  const semiIndex = source.indexOf(";", matchIndex);
  if (braceStart === -1 || (semiIndex !== -1 && semiIndex < braceStart)) {
    return source.slice(matchIndex, semiIndex + 1);
  }
  let depth = 0;
  let index = braceStart;
  for (; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        index += 1;
        break;
      }
    }
  }
  const tail = source.slice(index, index + 80);
  const trailingSemi = tail.match(/^[^\n{}]*;/);
  const end = trailingSemi ? index + trailingSemi[0].length : index;
  return source.slice(matchIndex, end);
}

/**
 * The scheduler PROCESS's real, executed Prisma surface -- deliberately NOT
 * `scheduler/index.ts`'s full static import graph. That graph also pulls in
 * every registered task HANDLER's implementation module (`moboreader.ts`,
 * `promo-link-claim.ts`, `sitemap-refresh.ts`, `side-effect-intent.ts`, ...)
 * purely so `SCHEDULER_HANDLERS`'s registry can type-check and resolve task
 * types -- `scheduler/index.ts`'s own header comment is explicit that
 * `main()` never calls any handler's `.handler` function body, only the
 * separate Worker process does. Scanning those modules here would demand
 * scheduler_app grants for tables it can structurally never read, defeating
 * the point of a precise guard. Two whole-file entries below (`scheduler/
 * index.ts`, `src/lib/tasks/scheduler.ts`) are intentional, not an oversight
 * -- both are small, self-contained, and (as of this writing) contain no
 * exported symbol whose Prisma calls scheduler's `main()` does not itself
 * reach, so slicing would add complexity without narrowing the scan.
 *
 * Known, accepted gap: `src/lib/tasks/scheduler.ts`'s `enqueueScheduledTask`
 * inserts its `schedule_run` row via a raw `tx.$queryRaw` `INSERT INTO
 * schedule_run (...)` rather than a `.scheduleRun.create(...)` call, and its
 * `tx.genericTask.create({ data: { items: { create: [...] } } })` nested
 * write populates `generic_task_item` without a standalone `.genericTaskItem.
 * *(` call site -- the accessor/relation-key scan below only catches the
 * former via `.scheduleRun.update(` (present in the same file for a
 * different statement) and does not attempt to catch either shape generally.
 * Both tables already carry an existing, unrelated scheduler_app grant
 * (`schedule_run`, `generic_task_item` -- see the static grant line above
 * this guard in grants.sql), so this gap does not currently hide anything;
 * it is called out here so a future reviewer does not read this guard as a
 * complete raw-SQL/nested-write scanner.
 */
const SCHEDULER_PRISMA_SURFACE: Array<{ file: string; extract: (source: string) => string }> = [
  { file: "scheduler/index.ts", extract: (source) => source },
  { file: "src/lib/locale/active-locales.ts", extract: (source) => extractDeclaration(source, "queryActiveLocales") },
  { file: "src/lib/seo/sitemap.ts", extract: (source) => extractDeclaration(source, "activePublicArticleWhere") },
  {
    file: "src/server/publication/visibility.ts",
    extract: (source) => [extractDeclaration(source, "PUBLIC_ARTICLE_RECORD"), extractDeclaration(source, "buildPublicArticleWhere")].join("\n"),
  },
  { file: "src/server/home-carousel/service.ts", extract: (source) => extractDeclaration(source, "getHomeCarouselConfig") },
  { file: "src/lib/tasks/scheduler.ts", extract: (source) => source },
];

const PRISMA_QUERY_METHODS = "findMany|findUnique|findFirst|create|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy";

/** Every physical table scheduler's real Prisma surface (above) references, either as a direct `db.<model>.<method>(` call or as a Prisma relation-filter key (`novel: { is: ... }`, `promoLink: { is: ... }`) inside a `WHERE` fragment it builds or consumes. */
function detectSchedulerTouchedTables(): Set<string> {
  const modelTableMap = parseModelTableMap(schemaSource);
  const touched = new Set<string>();
  for (const { file, extract } of SCHEDULER_PRISMA_SURFACE) {
    const source = readFileSync(resolve(root, file), "utf8");
    const slice = extract(source);
    for (const [accessor, table] of modelTableMap) {
      const callPattern = new RegExp(`\\b${accessor}\\s*\\.\\s*(${PRISMA_QUERY_METHODS})\\s*\\(`);
      const relationKeyPattern = new RegExp(`\\b${accessor}\\s*:\\s*\\{`);
      if (callPattern.test(slice) || relationKeyPattern.test(slice)) {
        touched.add(table);
      }
    }
  }
  return touched;
}

/** Tables grants.sql actually authorizes scheduler_app to SELECT (whole-table or column-scoped) or write. */
function schedulerAppGrantedTables(grantsSql: string): Set<string> {
  const tables = new Set<string>();
  for (const rawLine of grantsSql.split("\n")) {
    const line = rawLine.trim();
    if (!/^GRANT\b/.test(line)) continue;
    if (!/\bscheduler_app\b/.test(line)) continue;
    const columnScoped = line.match(/ON\s+(\w+)\s+TO\b/);
    if (columnScoped) {
      tables.add(columnScoped[1]!);
      continue;
    }
    const tableList = line.match(/ON TABLE\s+([\w,\s]+?)\s+TO\b/);
    if (tableList) {
      for (const table of tableList[1]!.split(",")) tables.add(table.trim());
    }
  }
  return tables;
}

describe("scheduler Prisma read surface stays inside its grants.sql grant set (L10N P5.2 regression guard)", () => {
  it("touches exactly the tables this round's fix (and the pre-existing schedule/task bookkeeping) accounts for", () => {
    const touched = [...detectSchedulerTouchedTables()].sort();
    expect(touched).toEqual(
      ["article", "cron_run", "generic_task", "novel", "promo_link", "schedule_run", "site_setting"].sort(),
    );
  });

  it("grants scheduler_app at least column-scoped access to every table its real Prisma surface touches", () => {
    const touched = detectSchedulerTouchedTables();
    const granted = schedulerAppGrantedTables(grants);
    for (const table of touched) {
      expect(
        granted.has(table),
        `scheduler's real (executed) Prisma call graph reads "${table}" but infra/postgres/grants.sql grants scheduler_app nothing on it -- this is exactly the L10N P5.2 regression class (queryActiveLocales shipped without a matching grants.sql update)`,
      ).toBe(true);
    }
  });
});
