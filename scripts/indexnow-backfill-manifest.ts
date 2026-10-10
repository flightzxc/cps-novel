/**
 * Generates a signed backfill candidate manifest for IndexNow submission.
 *
 * Ported EXTRACT_CORE from CPS `scripts/indexnow-backfill-manifest.ts` (236
 * lines) — kept: the manifest's output shape (`schema_version`/
 * `generated_at`/`release_commit`/`expected_count`/`count`/`note`/`entries`/
 * `content_sha256`), strict `--article-ids` validation (CPS 7e57779,
 * integer ids → UUIDs here), the mandatory `--expected-count`, write-the-file-
 * then-fail on a count mismatch, and the `fs.writeFile` `{ flag: "wx" }`
 * no-overwrite guard. Replaced: CPS's 236-line candidate query keys off
 * `batchTaskItem` (an AI-generation task table this codebase does not have) —
 * this script's candidate source is `listPublishedWithoutIndexNowDelivery`
 * instead: a cursor-complete difference query (no 5,000-article cap).
 * `docs/governance/port-registry.md` has the per-symbol registration.
 *
 * B-41: manifest `schema_version` is 2 (adds `cutover_at` and per-entry
 * `published_at`); `apply` reads 1 and 2.
 *
 * Usage:
 *   tsx scripts/indexnow-backfill-manifest.ts --help
 *   tsx scripts/indexnow-backfill-manifest.ts --count-only [--article-ids <uuid,...>] [--cutover-at <ISO>]
 *   tsx scripts/indexnow-backfill-manifest.ts --expected-count N --output <path> \
 *       [--article-ids <uuid,...>] [--cutover-at <ISO>]
 *
 * `--count-only` prints the count and the scan stats and writes nothing.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import {
  INDEXNOW_BACKFILL_MANIFEST_SCHEMA_VERSION,
  computeCutoverStats,
  computeManifestSha256,
  type IndexNowBackfillEntry,
  type IndexNowBackfillManifest,
  type IndexNowCutoverStats,
} from "../src/lib/indexnow/backfill-manifest";
import type { IndexNowEligibilityOptions } from "../src/lib/indexnow/eligibility";
import {
  classifyIndexNowBackfillArticleIds,
  listPublishedWithoutIndexNowDelivery,
  type IndexNowBackfillCandidate,
  type IndexNowBackfillStats,
} from "../src/lib/indexnow/outbox";

export const MANIFEST_USAGE = `Usage:
  tsx scripts/indexnow-backfill-manifest.ts --help
  tsx scripts/indexnow-backfill-manifest.ts --count-only [--article-ids <uuid,uuid,...>] [--cutover-at <ISO>]
  tsx scripts/indexnow-backfill-manifest.ts --expected-count <N> --output <path> [--article-ids <uuid,uuid,...>] [--cutover-at <ISO>]

  --count-only        print the candidate count and scan stats; write nothing (no file, exit 0)
  --expected-count N  required for every mode except --count-only/--help: the count the Owner confirmed.
                      A different actual count still writes the file, then exits 1.
  --output <path>     manifest file (alias --out); refuses to overwrite an existing file
  --article-ids       explicit selection; any duplicate, empty item, non-UUID, nonexistent id, id outside the
                      candidates or ineligible id rejects the WHOLE selection
  --cutover-at <ISO>  record the "new publications are pushed" cutover; adds per-entry published_at stats
`;

function formatIds(ids: readonly string[]): string {
  return `[${ids.join(",")}]`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** CPS 7e57779, UUID edition: at most once, requires a value, no empty item, UUIDs only (lowercased), no duplicates. */
export function parseArticleIdsArg(argv: readonly string[] = process.argv): string[] | undefined {
  const indexes = argv.flatMap((value, index) => (value === "--article-ids" ? [index] : []));
  if (indexes.length === 0) return undefined;
  if (indexes.length > 1) {
    throw new Error("--article-ids must be provided at most once");
  }

  const raw = argv[indexes[0]! + 1];
  if (raw === undefined || raw.startsWith("--")) {
    throw new Error("--article-ids <comma-separated UUID list> requires a value");
  }
  const tokens = raw.split(",").map((value) => value.trim());
  if (tokens.length === 0 || tokens.some((value) => value.length === 0)) {
    throw new Error("--article-ids must not contain an empty item");
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!UUID_RE.test(token)) {
      throw new Error(`--article-ids contains an invalid UUID: ${token}`);
    }
    const id = token.toLowerCase();
    if (seen.has(id)) {
      throw new Error(`--article-ids contains a duplicate ID: ${id}`);
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export interface ManifestCliArgs {
  help: boolean;
  countOnly: boolean;
  expectedCount?: number;
  output?: string;
  articleIds?: string[];
  cutoverAt?: Date;
}

export function parseManifestArgs(argv: readonly string[] = process.argv.slice(2)): ManifestCliArgs {
  // `parseArticleIdsArg` looks at the raw argv (like CPS), so it sees the same array.
  const help = argv.includes("--help") || argv.includes("-h");
  if (help) return { help: true, countOnly: false };
  const countOnly = argv.includes("--count-only");
  const articleIds = parseArticleIdsArg(argv);

  let expectedCount: number | undefined;
  if (!countOnly) {
    const rawExpected = argv.includes("--expected-count") ? argv[argv.indexOf("--expected-count") + 1] : undefined;
    // CPS: `Number(arg("--expected-count"))` → NaN when absent. Stricter here:
    // digits only, so "1e3" / "0x10" / " 5" cannot sneak through.
    if (rawExpected === undefined || !/^\d+$/.test(rawExpected) || !Number.isSafeInteger(Number(rawExpected))) {
      throw new Error("--expected-count <non-negative integer> is required; the script never hard-codes a candidate count");
    }
    expectedCount = Number(rawExpected);
  }

  const output = flagValue(argv, "--output") ?? flagValue(argv, "--out");

  let cutoverAt: Date | undefined;
  const rawCutover = flagValue(argv, "--cutover-at");
  if (rawCutover !== undefined) {
    cutoverAt = new Date(rawCutover);
    if (Number.isNaN(cutoverAt.getTime())) throw new Error(`--cutover-at is not a valid ISO timestamp: ${rawCutover}`);
  }
  return { help: false, countOnly, expectedCount, output, articleIds, cutoverAt };
}

export interface BuildBackfillManifestOptions {
  releaseCommit: string;
  expectedCount: number;
  note: string;
  now?: Date;
  cutoverAt?: Date | null;
}

export function buildBackfillManifest(
  candidates: ReadonlyArray<IndexNowBackfillCandidate>,
  options: BuildBackfillManifestOptions,
): IndexNowBackfillManifest {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const releaseWindow = generatedAt.slice(0, 10);
  const entries: IndexNowBackfillEntry[] = candidates.map((candidate) => ({
    article_id: candidate.articleId,
    novel_id: candidate.novelId,
    locale: candidate.locale,
    canonical_url: candidate.canonicalUrl,
    created_at: generatedAt,
    release_window: releaseWindow,
    eligibility_result: "eligible",
    published_at: candidate.publishedAt ? candidate.publishedAt.toISOString() : null,
  }));
  const withoutHash = {
    schema_version: INDEXNOW_BACKFILL_MANIFEST_SCHEMA_VERSION,
    generated_at: generatedAt,
    release_commit: options.releaseCommit,
    expected_count: options.expectedCount,
    count: entries.length,
    note: options.note,
    cutover_at: options.cutoverAt ? options.cutoverAt.toISOString() : null,
    entries,
  };
  return { ...withoutHash, content_sha256: computeManifestSha256(withoutHash) };
}

export interface BackfillCandidateSelection {
  candidates: IndexNowBackfillCandidate[];
  stats: IndexNowBackfillStats | { requestedArticleIds: number; eligible: number };
  cutoverStats: IndexNowCutoverStats;
  articleIds: string[] | null;
}

/**
 * Candidate selection shared by `--count-only` and manifest generation.
 * With `--article-ids`, ONLY those ids are queried and classified; any
 * nonexistent / outside-candidates / ineligible id rejects the whole selection
 * (`--article-ids rejected: nonexistent=[…]; outside_candidates=[…]; ineligible=[…]`).
 */
export async function selectBackfillCandidates(
  db: PrismaClient,
  options: { articleIds?: readonly string[]; cutoverAt?: Date | null; eligibilityOptions?: IndexNowEligibilityOptions; pageSize?: number } = {},
): Promise<BackfillCandidateSelection> {
  let candidates: IndexNowBackfillCandidate[];
  let stats: BackfillCandidateSelection["stats"];
  if (options.articleIds) {
    const classified = await classifyIndexNowBackfillArticleIds(db, options.articleIds, options.eligibilityOptions);
    const failures = [
      classified.nonexistent.length ? `nonexistent=${formatIds(classified.nonexistent)}` : "",
      classified.outsideCandidates.length ? `outside_candidates=${formatIds(classified.outsideCandidates)}` : "",
      classified.ineligible.length ? `ineligible=${formatIds(classified.ineligible)}` : "",
    ].filter(Boolean);
    if (failures.length > 0) {
      throw new Error(`--article-ids rejected: ${failures.join("; ")}`);
    }
    candidates = [...classified.eligible].sort((a, b) => (a.articleId < b.articleId ? -1 : a.articleId > b.articleId ? 1 : 0));
    stats = { requestedArticleIds: options.articleIds.length, eligible: candidates.length };
  } else {
    const listed = await listPublishedWithoutIndexNowDelivery(db, {
      pageSize: options.pageSize,
      eligibilityOptions: options.eligibilityOptions,
    });
    candidates = listed.candidates;
    stats = listed.stats;
  }
  return {
    candidates,
    stats,
    cutoverStats: computeCutoverStats(candidates, options.cutoverAt ?? null),
    articleIds: options.articleIds ? [...options.articleIds] : null,
  };
}

/**
 * Writes the manifest (never over an existing file), THEN checks the count —
 * CPS order: the file is evidence of what was actually found even when it
 * differs from what the Owner confirmed.
 */
export async function writeManifestFile(
  manifest: IndexNowBackfillManifest,
  outputPath: string,
  expectedCount: number,
  afterWrite?: () => void,
): Promise<void> {
  await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  afterWrite?.();
  if (manifest.count !== expectedCount) {
    throw new Error(
      `candidate count mismatch: actual=${manifest.count} expected=${expectedCount}; apply must wait for Owner confirmation`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseManifestArgs();
  if (args.help) {
    console.log(MANIFEST_USAGE);
    return;
  }
  const releaseCommit = process.env.GIT_COMMIT?.trim() || "unknown-local-commit";

  const prisma = new PrismaClient();
  try {
    const selection = await selectBackfillCandidates(prisma, { articleIds: args.articleIds, cutoverAt: args.cutoverAt });
    const stats = { ...selection.stats, ...selection.cutoverStats };
    if (args.countOnly) {
      console.log(JSON.stringify({ count: selection.candidates.length, stats }, null, 2));
      return;
    }

    const output = path.resolve(args.output ?? `indexnow-backfill-manifest-${new Date().toISOString().slice(0, 10)}.json`);
    const manifest = buildBackfillManifest(selection.candidates, {
      releaseCommit,
      expectedCount: args.expectedCount!,
      note: args.articleIds
        ? "explicit --article-ids selection (strictly validated)"
        : "游标全覆盖的差集: every published novel_article walked by id cursor, minus articles with any indexnow_outbox row, rechecked for eligibility",
      cutoverAt: args.cutoverAt ?? null,
    });
    const summary = {
      output,
      count: manifest.count,
      expectedCount: args.expectedCount,
      sha256: manifest.content_sha256,
      stats,
      articleIds: selection.articleIds,
    };
    // File first, summary second, count check last: a mismatching run still
    // leaves the evidence file and prints what it wrote before failing.
    await writeManifestFile(manifest, output, args.expectedCount!, () => console.log(JSON.stringify(summary, null, 2)));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
