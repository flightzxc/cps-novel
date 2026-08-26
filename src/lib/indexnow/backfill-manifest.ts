/**
 * Backfill manifest hash/verify primitives (Stream E, P2-11).
 *
 * Ported COPY_AS_IS from CPS `src/lib/indexnow-backfill-manifest.ts` (41
 * lines, `P2-07-12-移植审计-2026-08-12/P2-11.md` §7 "A · COPY_AS_IS").
 * The file lives under the Codex-owned `src/lib/indexnow/` module registered
 * in `CLAUDE.md`; scripts remain the producer/consumer boundary for this
 * standalone on-disk artifact contract. `docs/governance/port-registry.md`
 * has the per-symbol registration.
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
}

export interface IndexNowBackfillManifest {
  schema_version: 1;
  generated_at: string;
  release_commit: string;
  expected_count: number;
  count: number;
  note: string;
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
