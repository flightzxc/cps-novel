/**
 * Applies a signed IndexNow backfill manifest, gated behind CPS's two-gate
 * safety mechanism.
 *
 * Ported COPY_AS_IS from CPS `scripts/indexnow-backfill-apply.ts`
 * (`assertBackfillWriteGates`/`assertBackfillStopConditions`, 36 lines,
 * `P2-07-12-移植审计-2026-08-12/P2-11.md` §7 "A · COPY_AS_IS" —
 * `prisma.batchTask.count` swapped for the `GenericTask` equivalent, no
 * other logic change). The `main()` flow (95 lines) is COPY_THEN_ADAPT:
 * manifest read + SHA-256 verify + `release_commit` match + `--limit`
 * (hard-capped 500) / `--offset` pagination is unchanged; the candidate
 * verification and enqueue calls are retargeted at this codebase's
 * eligibility/outbox modules. `docs/governance/port-registry.md` has the
 * per-symbol registration.
 *
 * Two independent gates, both must be satisfied to write:
 *   Gate 1 (`main`, manifest integrity) — SHA-256 match, `count ===
 *     expected_count`, `release_commit` matches the running `GIT_COMMIT`.
 *   Gate 2 (`assertBackfillWriteGates` + `assertBackfillStopConditions`) —
 *     `--confirm` and `INDEXNOW_BACKFILL_ALLOW_WRITE=true` both present, and
 *     none of: any prior HTTP 403, more than 3 prior HTTP 422s, a terminal
 *     failure ratio above 5%, or any linked `GenericTask` already `failed`.
 *
 * Usage:
 *   tsx scripts/indexnow-backfill-apply.ts --manifest <path> [--limit N] [--offset N] [--confirm]
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { verifyManifestSha256, type IndexNowBackfillManifest } from "../src/lib/indexnow-backfill-manifest";
import { buildIndexNowCanonicalUrl, isNovelIndexNowEligible, loadIndexNowCandidateArticle } from "../src/lib/indexnow/eligibility";
import { enqueueIndexNowFirstPublish } from "../src/lib/indexnow/outbox";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function assertBackfillWriteGates(confirm: boolean, allowWrite: string | undefined): void {
  if (!confirm || allowWrite !== "true") {
    throw new Error("write requires both --confirm and INDEXNOW_BACKFILL_ALLOW_WRITE=true");
  }
}

export interface BackfillStopConditionRow {
  status: string;
  lastHttpStatus: number | null;
}

export function assertBackfillStopConditions(
  deliveries: readonly BackfillStopConditionRow[],
  failedWorkerTasks = 0,
): void {
  if (failedWorkerTasks > 0) {
    throw new Error("backfill stop condition: delivery worker task failed or crashed");
  }
  if (deliveries.some((delivery) => delivery.lastHttpStatus === 403)) {
    throw new Error("backfill stop condition: HTTP 403 requires manual key/config review");
  }
  const unprocessable = deliveries.filter((delivery) => delivery.lastHttpStatus === 422).length;
  if (unprocessable > 3) {
    throw new Error("backfill stop condition: more than 3 HTTP 422 responses");
  }
  const terminalFailures = deliveries.filter(
    (delivery) => delivery.status === "permanent_failed" || delivery.status === "dead_letter",
  ).length;
  if (deliveries.length > 0 && terminalFailures / deliveries.length > 0.05) {
    throw new Error("backfill stop condition: terminal failure ratio exceeds 5%");
  }
}

async function main(): Promise<void> {
  const manifestPath = arg("--manifest");
  if (!manifestPath) throw new Error("--manifest <path> is required");
  const manifest = JSON.parse(await fs.readFile(path.resolve(manifestPath), "utf8")) as IndexNowBackfillManifest;
  if (!verifyManifestSha256(manifest)) throw new Error("manifest SHA-256 mismatch; file was modified");
  if (manifest.count !== manifest.expected_count) {
    throw new Error(`candidate count mismatch: actual=${manifest.count} expected=${manifest.expected_count}`);
  }
  const currentCommit = process.env.GIT_COMMIT?.trim() || "unknown-local-commit";
  if (manifest.release_commit !== currentCommit) {
    throw new Error(`release commit mismatch: manifest=${manifest.release_commit} current=${currentCommit}`);
  }

  const write = process.argv.includes("--confirm");
  if (write) assertBackfillWriteGates(true, process.env.INDEXNOW_BACKFILL_ALLOW_WRITE);
  const limit = Math.max(1, Math.min(Number(arg("--limit") ?? manifest.entries.length), 500));
  const offset = Math.max(0, Number(arg("--offset") ?? 0));
  const selected = manifest.entries.slice(offset, offset + limit);

  const prisma = new PrismaClient();
  const report = { mode: write ? "apply" : "dry-run", eligible: 0, drifted: 0, enqueued: 0, duplicates: 0, ineligible: 0, disabled: 0 };
  try {
    const selectedArticleIds = selected.map((entry) => entry.article_id);
    const existing = selectedArticleIds.length === 0 ? [] : await prisma.indexNowOutbox.findMany({
      where: { articleId: { in: selectedArticleIds }, eventType: "article_first_publish", source: "backfill" },
      select: { status: true, lastHttpStatus: true, deliveryTaskId: true },
    });
    const deliveryTaskIds = existing.flatMap((delivery) => (delivery.deliveryTaskId ? [delivery.deliveryTaskId] : []));
    const failedWorkerTasks =
      deliveryTaskIds.length === 0
        ? 0
        : await prisma.genericTask.count({ where: { id: { in: deliveryTaskIds }, status: "failed" } });
    assertBackfillStopConditions(existing, failedWorkerTasks);

    for (const entry of selected) {
      const article = await loadIndexNowCandidateArticle(prisma, entry.article_id);
      const eligible = article ? isNovelIndexNowEligible(article, article.novel, article.promoLink) : false;
      const canonical = eligible && article ? buildIndexNowCanonicalUrl(article) : null;
      if (!canonical || canonical !== entry.canonical_url) {
        report.drifted++;
        continue;
      }
      report.eligible++;
      if (!write) continue;
      const result = await enqueueIndexNowFirstPublish(prisma, {
        articleId: entry.article_id,
        source: "backfill",
        eventType: "article_first_publish",
      });
      if (result.outcome === "enqueued" || result.outcome === "deferred") report.enqueued++;
      else if (result.outcome === "duplicate") report.duplicates++;
      else if (result.outcome === "ineligible") report.ineligible++;
      else report.disabled++;
    }
    console.log(JSON.stringify(report, null, 2));
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
