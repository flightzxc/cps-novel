/**
 * Generates a signed backfill candidate manifest for IndexNow submission.
 *
 * Ported EXTRACT_CORE from CPS `scripts/indexnow-backfill-manifest.ts` (236
 * lines) — kept: the manifest's output shape (`schema_version`/
 * `generated_at`/`release_commit`/`expected_count`/`count`/`note`/`entries`/
 * `content_sha256`), `--article-ids` explicit filtering, and the `fs.writeFile`
 * `{ flag: "wx" }` no-overwrite guard. Replaced: CPS's 236-line candidate
 * query keys off `batchTaskItem` (an AI-generation task table this codebase
 * does not have) — this script's candidate source is
 * `findPublishedWithoutIndexNowDelivery` instead, the difference-query this
 * Stream's audit recommends in its place
 * (`P2-07-12-移植审计-2026-08-12/P2-11.md` §5). `docs/governance/
 * port-registry.md` has the per-symbol registration.
 *
 * Usage:
 *   tsx scripts/indexnow-backfill-manifest.ts --out <path> [--limit N] [--article-ids id1,id2,...]
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import {
  computeManifestSha256,
  type IndexNowBackfillEntry,
  type IndexNowBackfillManifest,
} from "../src/lib/indexnow-backfill-manifest";
import { findPublishedWithoutIndexNowDelivery } from "../src/lib/indexnow/outbox";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function parseArticleIdsArg(raw: string | undefined): string[] | null {
  if (!raw?.trim()) return null;
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error("--article-ids was given but contained no valid ids");
  return ids;
}

export function buildBackfillManifest(
  candidates: ReadonlyArray<{ articleId: string; novelId: string; locale: string; canonicalUrl: string }>,
  options: { releaseCommit: string; expectedCount: number; note: string; now?: Date },
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
  }));
  const withoutHash = {
    schema_version: 1 as const,
    generated_at: generatedAt,
    release_commit: options.releaseCommit,
    expected_count: options.expectedCount,
    count: entries.length,
    note: options.note,
    entries,
  };
  return { ...withoutHash, content_sha256: computeManifestSha256(withoutHash) };
}

async function main(): Promise<void> {
  const outPath = arg("--out");
  if (!outPath) throw new Error("--out <path> is required");
  const limit = Number(arg("--limit") ?? 500);
  const articleIds = parseArticleIdsArg(arg("--article-ids"));
  const releaseCommit = process.env.GIT_COMMIT?.trim() || "unknown-local-commit";

  const prisma = new PrismaClient();
  try {
    let candidates = await findPublishedWithoutIndexNowDelivery(prisma, limit);
    if (articleIds) {
      const allowed = new Set(articleIds);
      candidates = candidates.filter((candidate) => allowed.has(candidate.articleId));
    }
    const manifest = buildBackfillManifest(candidates, {
      releaseCommit,
      expectedCount: candidates.length,
      note: articleIds ? "explicit --article-ids selection" : "findPublishedWithoutIndexNowDelivery difference query",
    });
    await fs.writeFile(path.resolve(outPath), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify({ outPath, count: manifest.count, releaseCommit }, null, 2));
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
