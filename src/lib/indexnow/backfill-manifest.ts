/**
 * Backfill manifest hash/verify primitives (Stream E, P2-11).
 *
 * Ported COPY_AS_IS from CPS `src/lib/indexnow-backfill-manifest.ts` (41
 * lines, `P2-07-12-移植审计-2026-08-12/P2-11.md` §7 "A · COPY_AS_IS").
 * The file lives under the Codex-owned `src/lib/indexnow/` module registered
 * in `CLAUDE.md`; scripts remain the producer/consumer boundary for this
 * standalone on-disk artifact contract. `docs/governance/port-registry.md`
 * has the per-symbol registration.
 *
 * B-41: `schema_version` is now 2. Version 2 adds `cutover_at` (manifest level)
 * and `published_at` (per entry) so the operator can see how many candidates
 * were published before/after the "new publications are pushed" cutover.
 * Version 1 manifests stay readable and verifiable (`apply` accepts 1 and 2):
 * the hash covers exactly the fields present in the file.
 */
import { createHash } from "node:crypto";

export interface IndexNowBackfillEntry {
  article_id: string;
  novel_id: string;
  locale: string;
  canonical_url: string;
  created_at: string;
  release_window: string;
  eligibility_result: "eligible";
  /** v2: `Article.publishedAt` (ISO) or null. Absent in v1 manifests. */
  published_at?: string | null;
}

export const INDEXNOW_BACKFILL_MANIFEST_SCHEMA_VERSION = 2 as const;
export const INDEXNOW_BACKFILL_SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2];

export interface IndexNowBackfillManifest {
  schema_version: 1 | 2;
  generated_at: string;
  release_commit: string;
  expected_count: number;
  count: number;
  note: string;
  /** v2: the cutover instant the operator passed to the generator (ISO), or null. Absent in v1. */
  cutover_at?: string | null;
  entries: IndexNowBackfillEntry[];
  content_sha256: string;
}

export function manifestHashPayload(
  manifest: Omit<IndexNowBackfillManifest, "content_sha256"> | IndexNowBackfillManifest,
): string {
  const payload: Partial<IndexNowBackfillManifest> = { ...(manifest as IndexNowBackfillManifest) };
  delete payload.content_sha256;
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function computeManifestSha256(
  manifest: Omit<IndexNowBackfillManifest, "content_sha256"> | IndexNowBackfillManifest,
): string {
  return createHash("sha256").update(manifestHashPayload(manifest)).digest("hex");
}

export function verifyManifestSha256(manifest: IndexNowBackfillManifest): boolean {
  return computeManifestSha256(manifest) === manifest.content_sha256;
}

export interface IndexNowCutoverBucket {
  urls: number;
  publishedBeforeCutover: number;
  publishedAfterCutover: number;
  /** Candidates with no `published_at` (cannot be placed relative to the cutover). */
  publishedAtMissing: number;
}

export interface IndexNowCutoverStats extends IndexNowCutoverBucket {
  cutoverAt: string | null;
  byLocale: Record<string, IndexNowCutoverBucket>;
}

/**
 * Splits candidates into published-before / published-after `cutoverAt`
 * (a candidate published exactly at the cutover counts as "after"), overall and
 * per locale. Without a cutover only `urls` and `publishedAtMissing` are filled.
 */
export function computeCutoverStats(
  candidates: ReadonlyArray<{ locale: string; publishedAt: Date | null }>,
  cutoverAt: Date | null,
): IndexNowCutoverStats {
  const empty = (): IndexNowCutoverBucket => ({
    urls: 0,
    publishedBeforeCutover: 0,
    publishedAfterCutover: 0,
    publishedAtMissing: 0,
  });
  const stats: IndexNowCutoverStats = {
    ...empty(),
    cutoverAt: cutoverAt ? cutoverAt.toISOString() : null,
    byLocale: {},
  };
  for (const candidate of candidates) {
    const bucket = (stats.byLocale[candidate.locale] ??= empty());
    for (const target of [stats, bucket]) {
      target.urls++;
      if (!candidate.publishedAt) target.publishedAtMissing++;
      else if (cutoverAt) {
        if (candidate.publishedAt.getTime() < cutoverAt.getTime()) target.publishedBeforeCutover++;
        else target.publishedAfterCutover++;
      }
    }
  }
  return stats;
}
