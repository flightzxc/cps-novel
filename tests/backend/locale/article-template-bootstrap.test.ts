import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ArticleTemplateBootstrapError,
  parseArticleTemplateBootstrapCliOptions,
  loadArticleTemplateBootstrapArtifacts,
  runArticleTemplateBootstrapCli,
  type ArticleTemplateBootstrapDb,
} from "../../../scripts/l10n/article-template-bootstrap";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";

/**
 * L10N P3（`施工提示词_Sonnet_L10N_P3_模板locale非空化与15语模板资产_2026-09-10.md`
 * §1.G，矩阵 #5）: fast, DB-free regression net for
 * `scripts/l10n/article-template-bootstrap.ts`'s SHA pin / structural
 * invariant / approver-gate / idempotency contract, same precedent as
 * `tests/backend/locale/backfill-source-item-locale.test.ts` and
 * `tests/backend/tagging/bootstrap.test.ts`.
 */

type Row = {
  id: string;
  templateKey: string;
  templateName: string;
  locale: string;
  version: number;
  schemaVersion: number;
  status: string;
  applicableArticleType: string;
  bodyTemplate: string;
  contentTemplate: unknown;
  seoTemplate: unknown;
  slugTemplate: string;
  metaKeywordsTemplate: string;
};

class FakeArticleTemplateBootstrapDb implements ArticleTemplateBootstrapDb {
  readonly rows: Row[] = [];
  readonly audits: Array<Record<string, unknown>> = [];
  readonly admins: Array<{ id: string; username: string; status: string }> = [
    { id: "11111111-1111-4111-8111-111111111111", username: "approver-1", status: "active" },
    { id: "22222222-2222-4222-8222-222222222222", username: "inactive-approver", status: "disabled" },
  ];
  readonly calls: string[] = [];
  private nextAuditId = 1n;

  readonly articleTemplate = {
    findMany: async (args: { where: { templateKey: { in: string[] } } }): Promise<Row[]> => {
      this.calls.push("articleTemplate.findMany");
      const keys = new Set(args.where.templateKey.in);
      return this.rows.filter((row) => keys.has(row.templateKey)).map((row) => structuredClone(row));
    },
    upsert: async (args: {
      where: { templateKey_version: { templateKey: string; version: number } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<Row> => {
      this.calls.push("articleTemplate.upsert");
      const { templateKey, version } = args.where.templateKey_version;
      const existing = this.rows.find((row) => row.templateKey === templateKey && row.version === version);
      if (existing) {
        Object.assign(existing, args.update);
        return structuredClone(existing);
      }
      const row: Row = {
        id: `template-${this.rows.length + 1}`,
        templateKey,
        version,
        ...(args.create as Omit<Row, "id" | "templateKey" | "version">),
      };
      this.rows.push(row);
      return structuredClone(row);
    },
  };

  readonly adminIdentity = {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      this.calls.push("adminIdentity.findFirst");
      const where = args.where as { id?: string; username?: string };
      return this.admins.find((admin) => (where.id ? admin.id === where.id : admin.username === where.username)) ?? null;
    },
  };

  readonly operationAudit = {
    create: async (args: { data: Record<string, unknown> }) => {
      this.calls.push("operationAudit.create");
      const id = this.nextAuditId;
      this.nextAuditId += 1n;
      this.audits.push({ id, ...args.data });
      return { id };
    },
  };

  async $transaction<T>(run: (tx: ArticleTemplateBootstrapDb) => Promise<T>): Promise<T> {
    return run(this);
  }
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("article-template-bootstrap CLI option parsing", () => {
  it("is dry-run by default", () => {
    expect(parseArticleTemplateBootstrapCliOptions([])).toEqual({ apply: false, approver: null });
  });

  it("requires --approver for --apply", () => {
    expect(() => parseArticleTemplateBootstrapCliOptions(["--apply"])).toThrowError(ArticleTemplateBootstrapError);
    try {
      parseArticleTemplateBootstrapCliOptions(["--apply"]);
    } catch (error) {
      expect((error as ArticleTemplateBootstrapError).code).toBe("approver_required");
    }
  });

  it("parses --apply --approver", () => {
    expect(parseArticleTemplateBootstrapCliOptions(["--apply", "--approver", "admin-1"])).toEqual({
      apply: true,
      approver: "admin-1",
    });
  });
});

describe("article-template-bootstrap real repository assets (真读资产文件)", () => {
  it("loads the real 15 assets/article-templates/*.json with matching manifest SHA-256 and passes every structural invariant against en.json", () => {
    const artifacts = loadArticleTemplateBootstrapArtifacts();
    expect(artifacts.assetsByLocale.size).toBe(SITE_LOCALES.length);
    for (const locale of SITE_LOCALES) {
      const asset = artifacts.assetsByLocale.get(locale);
      expect(asset).toBeDefined();
      expect(asset!.locale).toBe(locale);
      expect(asset!.templateKey).toBe(locale === "en" ? "system-default-v1" : `system-default-${locale}-v1`);
      expect(asset!.version).toBe(1);
      expect(asset!.status).toBe("active");
      expect(asset!.applicableArticleType).toBe("novel_article");
    }
    expect(artifacts.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("en.json's bodyTemplate/contentTemplate/seoTemplate are byte-exact to the current system-default-v1 constants (DEFAULT_ARTICLE_TEMPLATE / SYSTEM_DEFAULT_CONTENT_BLOCKS)", () => {
    const artifacts = loadArticleTemplateBootstrapArtifacts();
    const en = artifacts.assetsByLocale.get("en")!;
    const expectedBody = [
      "<article>",
      "<h1>{novel_title}</h1>",
      '{if cover_url}<p><img src="{cover_url}" alt="Cover"></p>{endif}',
      "<p>{novel_description}</p>",
      "{if total_chapter_count}<p>Total chapters: {total_chapter_count}</p>{endif}",
      "{if preview_chapter_count}<p>Free preview chapters available: {preview_chapter_count}</p>{endif}",
      '{if promo_redirect_url}<p><a href="{promo_redirect_url}">Start Reading</a></p>{endif}',
      "</article>",
    ].join("");
    expect(en.bodyTemplate).toBe(expectedBody);
    expect(en.contentTemplate).toEqual([
      { type: "heading", content: "{novel_title}" },
      { type: "image", content: "" },
      { type: "paragraph", content: "{novel_description}" },
      { type: "paragraph", content: "{if total_chapter_count}Total chapters: {total_chapter_count}{endif}" },
      { type: "paragraph", content: "{if preview_chapter_count}Free preview chapters available: {preview_chapter_count}{endif}" },
      { type: "cta", content: "Start Reading" },
    ]);
    expect(en.seoTemplate).toEqual({ title: "{novel_title}", metaTitle: "{novel_title}", metaDescription: "{novel_description}" });
  });
});

describe("article-template-bootstrap artifact loading (fixture-sized, mirrors the real 15-file set with one locale corrupted)", () => {
  it("rejects a file whose bytes don't match the manifest's pinned SHA-256", () => {
    // Point the loader at a full 15-locale mirror of the real assets directory,
    // then corrupt exactly one file's manifest-declared SHA, to exercise the
    // loader end-to-end (it requires all SITE_LOCALES present).
    const fullDir = mkdtempSync(join(tmpdir(), "l10n-p3-assets-sha-full-"));
    mirrorRealAssetsWithOverride(fullDir, { locale: "ru", manifestShaOverride: "0".repeat(64) });
    expect(() => loadArticleTemplateBootstrapArtifacts(fullDir, ".")).toThrowError(ArticleTemplateBootstrapError);
    try {
      loadArticleTemplateBootstrapArtifacts(fullDir, ".");
    } catch (error) {
      expect((error as ArticleTemplateBootstrapError).code).toBe("asset_sha256_mismatch");
    }
  });

  it("rejects a translation that drops a variable placeholder — mutation ③'s target (任一译文删一个变量占位符 → dry-run 红)", () => {
    const dir = mkdtempSync(join(tmpdir(), "l10n-p3-assets-token-"));
    mirrorRealAssetsWithOverride(dir, { locale: "ru", dropPlaceholderInBody: true });
    expect(() => loadArticleTemplateBootstrapArtifacts(dir, ".")).toThrowError(ArticleTemplateBootstrapError);
    try {
      loadArticleTemplateBootstrapArtifacts(dir, ".");
    } catch (error) {
      expect((error as ArticleTemplateBootstrapError).code).toBe("asset_invariant_violation");
    }
  });
});

/**
 * Copies the repository's real 15 assets/article-templates/*.json + manifest.json
 * into `targetDir`, optionally corrupting one locale's file (dropping a
 * `{total_chapter_count}` placeholder from its bodyTemplate, and/or
 * recomputing/overriding the manifest SHA for that file) before writing it
 * back out — used to exercise the full 15-locale loader's negative paths
 * without hand-building all 15 fixture files per test.
 */
function mirrorRealAssetsWithOverride(
  targetDir: string,
  opts: { locale: string; dropPlaceholderInBody?: boolean; manifestShaOverride?: string },
) {
  const REAL_DIR = join(process.cwd(), "assets/article-templates");
  mkdirSync(targetDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(REAL_DIR, "manifest.json"), "utf8")) as {
    files: Record<string, { locale: string; templateKey: string; sha256: string; bytes: number }>;
  };
  for (const [filename, entry] of Object.entries(manifest.files)) {
    let bytes = readFileSync(join(REAL_DIR, filename));
    if (entry.locale === opts.locale && opts.dropPlaceholderInBody) {
      const doc = JSON.parse(bytes.toString("utf8")) as { bodyTemplate: string };
      doc.bodyTemplate = doc.bodyTemplate.replace("{total_chapter_count}", "");
      const json = JSON.stringify(doc, null, 2) + "\n";
      bytes = Buffer.from(json, "utf8");
      entry.sha256 = sha256(bytes);
      entry.bytes = bytes.byteLength;
    } else if (entry.locale === opts.locale && opts.manifestShaOverride) {
      entry.sha256 = opts.manifestShaOverride;
    }
    writeFileSync(join(targetDir, filename), bytes);
  }
  writeFileSync(join(targetDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

describe("article-template-bootstrap dry-run", () => {
  it("reports 15 planned creates and writes nothing when the table is empty", async () => {
    const db = new FakeArticleTemplateBootstrapDb();
    const artifacts = loadArticleTemplateBootstrapArtifacts();
    const report = await runArticleTemplateBootstrapCli(db, { apply: false, approver: null }, artifacts);
    expect(report).toMatchObject({
      mode: "dry-run",
      wrote: false,
      auditId: null,
      planned: { create: SITE_LOCALES.length, update: 0, unchanged: 0 },
      applied: null,
    });
    expect(db.rows).toHaveLength(0);
    expect(db.calls).not.toContain("articleTemplate.upsert");
    expect(db.calls).not.toContain("operationAudit.create");
  });
});

describe("article-template-bootstrap apply", () => {
  it("rejects an approver that does not exist, writing nothing", async () => {
    const db = new FakeArticleTemplateBootstrapDb();
    const artifacts = loadArticleTemplateBootstrapArtifacts();
    await expect(
      runArticleTemplateBootstrapCli(db, { apply: true, approver: "99999999-9999-4999-8999-999999999999" }, artifacts),
    ).rejects.toMatchObject({ code: "approver_not_found" });
    expect(db.rows).toHaveLength(0);
  });

  it("rejects an approver that exists but is not active, writing nothing", async () => {
    const db = new FakeArticleTemplateBootstrapDb();
    const artifacts = loadArticleTemplateBootstrapArtifacts();
    await expect(
      runArticleTemplateBootstrapCli(db, { apply: true, approver: "inactive-approver" }, artifacts),
    ).rejects.toMatchObject({ code: "approver_inactive" });
    expect(db.rows).toHaveLength(0);
  });

  it("creates all 15 rows and writes exactly one OperationAudit row carrying the manifest SHA-256", async () => {
    const db = new FakeArticleTemplateBootstrapDb();
    const artifacts = loadArticleTemplateBootstrapArtifacts();
    const report = await runArticleTemplateBootstrapCli(db, { apply: true, approver: "approver-1" }, artifacts);

    expect(report).toMatchObject({
      mode: "apply",
      wrote: true,
      applied: { created: SITE_LOCALES.length, updated: 0, unchanged: 0 },
    });
    expect(db.rows).toHaveLength(SITE_LOCALES.length);
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      action: "article_template.bootstrap",
      entityType: "ArticleTemplate",
    });
    const snapshot = db.audits[0]!.afterSnapshot as { manifestSha256: string };
    expect(snapshot.manifestSha256).toBe(artifacts.manifestSha256);

    for (const locale of SITE_LOCALES) {
      const expectedKey = locale === "en" ? "system-default-v1" : `system-default-${locale}-v1`;
      const row = db.rows.find((candidate) => candidate.templateKey === expectedKey);
      expect(row).toBeDefined();
      expect(row!.locale).toBe(locale);
      expect(row!.status).toBe("active");
    }
  });

  it("is idempotent: a second apply against unchanged assets writes zero row changes (按 templateKey 幂等，重跑零变化)", async () => {
    const db = new FakeArticleTemplateBootstrapDb();
    const artifacts = loadArticleTemplateBootstrapArtifacts();
    await runArticleTemplateBootstrapCli(db, { apply: true, approver: "approver-1" }, artifacts);
    const snapshotAfterFirst = structuredClone(db.rows).sort((a, b) => a.templateKey.localeCompare(b.templateKey));

    const secondReport = await runArticleTemplateBootstrapCli(db, { apply: true, approver: "approver-1" }, artifacts);

    expect(secondReport.applied).toEqual({ created: 0, updated: 0, unchanged: SITE_LOCALES.length });
    expect(db.rows).toHaveLength(SITE_LOCALES.length);
    const snapshotAfterSecond = structuredClone(db.rows).sort((a, b) => a.templateKey.localeCompare(b.templateKey));
    expect(snapshotAfterSecond).toEqual(snapshotAfterFirst);
    // The audit trail itself is allowed to grow (one row of provenance per
    // run) — idempotency is a claim about the ArticleTemplate rows, not
    // about how many times bootstrap has ever been run.
    expect(db.audits).toHaveLength(2);
  });
});
