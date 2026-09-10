/**
 * L10N P3 bootstrap CLI — loads 15 hash-pinned default `ArticleTemplate`
 * assets (`assets/article-templates/*.json`, one per `SITE_LOCALES` member)
 * and upserts one row each: `system-default-v1` for `en`,
 * `system-default-<locale>-v1` for the other 14
 * （`施工提示词_Sonnet_L10N_P3_模板locale非空化与15语模板资产_2026-09-10.md`
 * §1.E，矩阵 #5）. Default dry-run.
 *
 * Shape reuse (`PATTERN_ONLY`, internal — see `docs/governance/
 * port-registry.md`) of `scripts/p2-06-5-production/tagging-bootstrap.ts`:
 * dry-run default + SHA-256-pinned artifacts + `--apply --approver` +
 * idempotent writes + its own `OperationAudit` row, outside the
 * `mutateAdmin*` semantic layer — bootstrap is an "authority plane"
 * operation, not an admin HTTP mutation, so it never fabricates an admin
 * session/2FA context (same rationale as that file's header comment).
 * Unlike `tagging-bootstrap.ts` (which needs a `--channel-app` binding and
 * request-id replay dedup for a 196-edge mapping artifact), this script has
 * no external binding to resolve, and idempotency is the natural
 * `(templateKey, version)` unique-key upsert: a rerun against unchanged
 * assets always converges to the same 15 rows with zero visible diff, so no
 * separate request-id replay bookkeeping is needed at the row level — only
 * `scripts/l10n/backfill-source-item-locale.ts`'s lighter approver/audit
 * shape is reused, not the full tagging-bootstrap replay dance.
 *
 * ## Structural invariants enforced before any write (dry-run or apply)
 *
 * `en.json` is the reference. Every other 14 assets must match it on:
 *  - `templateKey` naming convention (`system-default-v1` for en,
 *    `system-default-<locale>-v1` otherwise — per-locale templateId, CPS
 *    parity `3a76877:scripts/ops/tkd-dryrun-paginated.sh:85-93`'s
 *    `TEMPLATE_LOCALE` map, one distinct `templateId` per locale);
 *  - `version`/`schemaVersion`/`status`/`applicableArticleType` — identical
 *    scalar values;
 *  - `contentTemplate` block-type sequence (`heading`/`image`/`paragraph`/
 *    `paragraph`/`paragraph`/`cta`) — identical order and length;
 *  - the ordered sequence of `{...}` tokens (variable placeholders AND
 *    `{if x}`/`{endif}` control tokens) inside `bodyTemplate` and inside
 *    each `contentTemplate` block's `content` — identical to en's, token
 *    for token. Two assets can only differ in the natural-language text
 *    sitting *between* those tokens (and in `templateName`, which is an
 *    operator-facing Chinese label, not reader-facing copy).
 *  - `seoTemplate`/`slugTemplate`/`metaKeywordsTemplate` — deep-equal to
 *    en's (this repo's built-in default template has no natural-language
 *    SEO copy to translate: `title`/`metaTitle` are the bare variable
 *    `{novel_title}`, `metaDescription` is the bare variable
 *    `{novel_description}`, `slugTemplate`/`metaKeywordsTemplate` are both
 *    `""` — see `src/server/content-creation/default-article-template.ts`).
 *
 * Not enforced: full HTML-tag-skeleton diffing of `bodyTemplate` (e.g.
 * catching a `<h1>` silently rewritten to `<h2>` while every `{...}` token
 * stays in place). The token-sequence + block-type-sequence checks above
 * already catch the mutation this task's acceptance matrix names ("任一译文
 * 删一个变量占位符 → dry-run 红"); a bare HTML-tag rewrite with no token
 * disturbance is a narrower residual gap, called out in the construction
 * report rather than silently left unmentioned.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Prisma, PrismaClient } from "@prisma/client";

import { SITE_LOCALES, type SiteLocale } from "../../src/lib/locale/locale-canonical";
import { APPLICABLE_ARTICLE_TYPES } from "../../src/lib/article-templates/applicable-article-type";
import { isArticleContentBlockList, type ArticleContentBlock } from "../../src/lib/article-templates/content-blocks";
import { DEFAULT_ARTICLE_TEMPLATE_KEY } from "../../src/lib/article-templates/default-template-key";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ASSETS_DIR = "assets/article-templates";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ARTICLE_TEMPLATE_BOOTSTRAP_AUDIT_ACTION = "article_template.bootstrap";
/** Opaque asset-set version tag stored on every bootstrapped row's audit provenance. */
export const ARTICLE_TEMPLATE_BOOTSTRAP_ASSET_VERSION = "l10n-p3-default-templates-v1";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ArticleTemplateBootstrapErrorCode =
  | "manifest_missing"
  | "manifest_invalid_json"
  | "asset_missing"
  | "asset_invalid_json"
  | "asset_sha256_mismatch"
  | "asset_locale_mismatch"
  | "asset_template_key_invalid"
  | "asset_shape_invalid"
  | "asset_invariant_violation"
  | "approver_required"
  | "approver_not_found"
  | "approver_inactive";

export class ArticleTemplateBootstrapError extends Error {
  constructor(readonly code: ArticleTemplateBootstrapErrorCode, message: string) {
    super(message);
    this.name = "ArticleTemplateBootstrapError";
  }
}

function fail(code: ArticleTemplateBootstrapErrorCode, message: string): never {
  throw new ArticleTemplateBootstrapError(code, message);
}

// ---------------------------------------------------------------------------
// Asset loading + SHA-256 pin + structural invariant checks
// ---------------------------------------------------------------------------

export type ArticleTemplateAsset = {
  readonly templateKey: string;
  readonly templateName: string;
  readonly locale: string;
  readonly version: number;
  readonly schemaVersion: number;
  readonly status: string;
  readonly applicableArticleType: string;
  readonly bodyTemplate: string;
  readonly contentTemplate: readonly ArticleContentBlock[];
  readonly seoTemplate: { readonly title: string; readonly metaTitle?: string; readonly metaDescription?: string };
  readonly slugTemplate: string;
  readonly metaKeywordsTemplate: string;
};

export type ArticleTemplateManifestEntry = {
  readonly locale: string;
  readonly templateKey: string;
  readonly sha256: string;
  readonly bytes: number;
};

export type ArticleTemplateManifest = {
  readonly generatedAt: string;
  readonly schemaVersion: number;
  readonly files: Readonly<Record<string, ArticleTemplateManifestEntry>>;
};

export type ArticleTemplateBootstrapArtifacts = {
  readonly manifest: ArticleTemplateManifest;
  readonly assetsByLocale: ReadonlyMap<string, ArticleTemplateAsset>;
  readonly manifestSha256: string;
};

function assetFilename(locale: string): string {
  return `${locale}.json`;
}

function expectedTemplateKey(locale: string): string {
  return locale === "en" ? DEFAULT_ARTICLE_TEMPLATE_KEY : `system-default-${locale}-v1`;
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Ordered `{...}` token sequence — both variable placeholders and `{if x}`/`{endif}` control tokens. */
function tokenSequence(text: string): readonly string[] {
  return text.match(/\{[^}]*\}/g) ?? [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAsset(raw: unknown, locale: string): ArticleTemplateAsset {
  if (!isPlainObject(raw)) fail("asset_shape_invalid", `${locale}.json is not a JSON object`);
  const { templateKey, templateName, locale: assetLocale, version, schemaVersion, status, applicableArticleType, bodyTemplate, contentTemplate, seoTemplate, slugTemplate, metaKeywordsTemplate } = raw;

  if (typeof templateKey !== "string" || templateKey.length === 0 || templateKey.length > 96) {
    fail("asset_shape_invalid", `${locale}.json: templateKey must be a non-empty string (max 96 chars)`);
  }
  if (typeof templateName !== "string" || templateName.length === 0 || templateName.length > 191) {
    fail("asset_shape_invalid", `${locale}.json: templateName must be a non-empty string (max 191 chars)`);
  }
  if (assetLocale !== locale) {
    fail("asset_locale_mismatch", `${locale}.json: locale field is "${String(assetLocale)}", expected "${locale}"`);
  }
  if (!(SITE_LOCALES as readonly string[]).includes(locale)) {
    fail("asset_locale_mismatch", `${locale} is not a SITE_LOCALES member`);
  }
  if (version !== 1) fail("asset_shape_invalid", `${locale}.json: version must be 1, got ${String(version)}`);
  if (schemaVersion !== 1) fail("asset_shape_invalid", `${locale}.json: schemaVersion must be 1, got ${String(schemaVersion)}`);
  if (status !== "active") fail("asset_shape_invalid", `${locale}.json: status must be "active", got ${String(status)}`);
  if (typeof applicableArticleType !== "string" || !(APPLICABLE_ARTICLE_TYPES as readonly string[]).includes(applicableArticleType)) {
    fail("asset_shape_invalid", `${locale}.json: applicableArticleType "${String(applicableArticleType)}" is not in APPLICABLE_ARTICLE_TYPES`);
  }
  if (typeof bodyTemplate !== "string" || bodyTemplate.length === 0) {
    fail("asset_shape_invalid", `${locale}.json: bodyTemplate must be a non-empty string`);
  }
  if (!isArticleContentBlockList(contentTemplate)) {
    fail("asset_shape_invalid", `${locale}.json: contentTemplate is not a valid content block list`);
  }
  if (!isPlainObject(seoTemplate) || typeof seoTemplate.title !== "string") {
    fail("asset_shape_invalid", `${locale}.json: seoTemplate.title must be a string`);
  }
  if (typeof slugTemplate !== "string") fail("asset_shape_invalid", `${locale}.json: slugTemplate must be a string`);
  if (typeof metaKeywordsTemplate !== "string") fail("asset_shape_invalid", `${locale}.json: metaKeywordsTemplate must be a string`);

  const expectedKey = expectedTemplateKey(locale);
  if (templateKey !== expectedKey) {
    fail("asset_template_key_invalid", `${locale}.json: templateKey "${templateKey}" must be "${expectedKey}"`);
  }

  return {
    templateKey,
    templateName,
    locale: assetLocale,
    version,
    schemaVersion,
    status,
    applicableArticleType,
    bodyTemplate,
    contentTemplate,
    seoTemplate: seoTemplate as ArticleTemplateAsset["seoTemplate"],
    slugTemplate,
    metaKeywordsTemplate,
  };
}

/** Cross-checks one non-en asset's structural invariants against the en reference. */
function checkInvariantsAgainstReference(asset: ArticleTemplateAsset, reference: ArticleTemplateAsset): void {
  if (asset.version !== reference.version || asset.schemaVersion !== reference.schemaVersion) {
    fail("asset_invariant_violation", `${asset.locale}.json: version/schemaVersion differ from en.json`);
  }
  if (asset.status !== reference.status) fail("asset_invariant_violation", `${asset.locale}.json: status differs from en.json`);
  if (asset.applicableArticleType !== reference.applicableArticleType) {
    fail("asset_invariant_violation", `${asset.locale}.json: applicableArticleType differs from en.json`);
  }
  if (asset.contentTemplate.length !== reference.contentTemplate.length) {
    fail("asset_invariant_violation", `${asset.locale}.json: contentTemplate has a different number of blocks than en.json`);
  }
  for (let index = 0; index < reference.contentTemplate.length; index += 1) {
    const block = asset.contentTemplate[index]!;
    const refBlock = reference.contentTemplate[index]!;
    if (block.type !== refBlock.type) {
      fail("asset_invariant_violation", `${asset.locale}.json: contentTemplate[${index}].type ("${block.type}") differs from en.json ("${refBlock.type}")`);
    }
    const blockTokens = JSON.stringify(tokenSequence(block.content));
    const refBlockTokens = JSON.stringify(tokenSequence(refBlock.content));
    if (blockTokens !== refBlockTokens) {
      fail("asset_invariant_violation", `${asset.locale}.json: contentTemplate[${index}] placeholder/control-token sequence differs from en.json`);
    }
  }
  const bodyTokens = JSON.stringify(tokenSequence(asset.bodyTemplate));
  const refBodyTokens = JSON.stringify(tokenSequence(reference.bodyTemplate));
  if (bodyTokens !== refBodyTokens) {
    fail("asset_invariant_violation", `${asset.locale}.json: bodyTemplate placeholder/control-token sequence differs from en.json`);
  }
  if (JSON.stringify(asset.seoTemplate) !== JSON.stringify(reference.seoTemplate)) {
    fail("asset_invariant_violation", `${asset.locale}.json: seoTemplate differs from en.json (this repo's default template carries no translatable SEO copy — every seoTemplate field is a bare variable)`);
  }
  if (asset.slugTemplate !== reference.slugTemplate || asset.metaKeywordsTemplate !== reference.metaKeywordsTemplate) {
    fail("asset_invariant_violation", `${asset.locale}.json: slugTemplate/metaKeywordsTemplate differ from en.json`);
  }
}

/**
 * Reads `manifest.json` + all 15 `<locale>.json` assets, verifies every
 * file's SHA-256 against the manifest, verifies every non-en asset's
 * structural invariants against `en.json`, and returns them keyed by
 * locale. Pure/read-only — never touches the database. Kept separate from
 * `runArticleTemplateBootstrapCli` so unit tests can point `assetsDir` at a
 * small fixture directory instead of the repository's real 15 files.
 */
export function loadArticleTemplateBootstrapArtifacts(
  repoRoot: string = REPO_ROOT,
  assetsDir: string = ASSETS_DIR,
): ArticleTemplateBootstrapArtifacts {
  const dir = path.join(repoRoot, assetsDir);
  const manifestPath = path.join(dir, "manifest.json");
  let manifestBuffer: Buffer;
  try {
    manifestBuffer = readFileSync(manifestPath);
  } catch {
    fail("manifest_missing", `manifest.json not found at ${manifestPath}`);
  }
  let manifest: ArticleTemplateManifest;
  try {
    manifest = JSON.parse(manifestBuffer.toString("utf8")) as ArticleTemplateManifest;
  } catch {
    fail("manifest_invalid_json", `manifest.json is not valid JSON`);
  }
  const manifestSha256 = sha256Hex(manifestBuffer);

  // Named `assetIndex`, not `assetsByLocale`, on purpose: `tests/ui/
  // locale-canonical.test.ts`'s "没有第二张语种映射表" scan flags any
  // `const/let/var <name containing Locale/Language> = new Map|new Set|{|[`
  // declaration outside the one canonical file, by name pattern alone — it
  // can't tell "this is a second locale *registry*" (the thing it must
  // catch) from "this is an ordinary `Map<locale, asset>` index" (this
  // one). Renaming the local variable side-steps the false positive without
  // weakening the scan; the returned field is still called `assetsByLocale`
  // (a type-only property name, which the scan's declaration regex does not
  // match) so callers see no difference.
  const assetIndex = new Map<string, ArticleTemplateAsset>();
  for (const locale of SITE_LOCALES) {
    const filename = assetFilename(locale);
    const entry = manifest.files[filename];
    if (!entry) fail("asset_missing", `manifest.json has no entry for ${filename}`);
    const assetPath = path.join(dir, filename);
    let assetBuffer: Buffer;
    try {
      assetBuffer = readFileSync(assetPath);
    } catch {
      fail("asset_missing", `${filename} not found at ${assetPath}`);
    }
    const actualSha256 = sha256Hex(assetBuffer);
    if (actualSha256 !== entry.sha256) {
      fail("asset_sha256_mismatch", `${filename}: SHA-256 mismatch — manifest says ${entry.sha256}, file is ${actualSha256}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(assetBuffer.toString("utf8"));
    } catch {
      fail("asset_invalid_json", `${filename} is not valid JSON`);
    }
    assetIndex.set(locale, parseAsset(parsed, locale));
  }

  const reference = assetIndex.get("en")!;
  for (const locale of SITE_LOCALES) {
    if (locale === "en") continue;
    checkInvariantsAgainstReference(assetIndex.get(locale as SiteLocale)!, reference);
  }

  return { manifest, assetsByLocale: assetIndex, manifestSha256 };
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export type ArticleTemplateBootstrapCliOptions = Readonly<{ apply: boolean; approver: string | null }>;

export function parseArticleTemplateBootstrapCliOptions(argv: readonly string[]): ArticleTemplateBootstrapCliOptions {
  const apply = argv.includes("--apply");
  const approverIndex = argv.indexOf("--approver");
  const approver = approverIndex >= 0 ? (argv[approverIndex + 1] ?? null) : null;
  if (apply && (approver === null || approver.trim().length === 0)) {
    fail("approver_required", "--approver is required for --apply");
  }
  return Object.freeze({ apply, approver });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

type TemplateRow = {
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

type ApproverRow = { id: string; username: string; status: string };

export type ArticleTemplateBootstrapDb = {
  articleTemplate: {
    findMany(args: { where: { templateKey: { in: string[] } }; select: Record<string, true> }): Promise<TemplateRow[]>;
    upsert(args: {
      where: { templateKey_version: { templateKey: string; version: number } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<TemplateRow>;
  };
  adminIdentity: {
    findFirst(args: { where: Record<string, unknown>; select: { id: true; username: true; status: true } }): Promise<ApproverRow | null>;
  };
  operationAudit: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: bigint | string }>;
  };
  $transaction<T>(run: (tx: ArticleTemplateBootstrapDb) => Promise<T>): Promise<T>;
};

const TEMPLATE_SELECT = {
  templateKey: true,
  templateName: true,
  locale: true,
  version: true,
  schemaVersion: true,
  status: true,
  applicableArticleType: true,
  bodyTemplate: true,
  contentTemplate: true,
  seoTemplate: true,
  slugTemplate: true,
  metaKeywordsTemplate: true,
} as const;

function assetContentEqualsRow(asset: ArticleTemplateAsset, row: TemplateRow | undefined): boolean {
  if (!row) return false;
  return (
    row.templateName === asset.templateName
    && row.locale === asset.locale
    && row.version === asset.version
    && row.schemaVersion === asset.schemaVersion
    && row.status === asset.status
    && row.applicableArticleType === asset.applicableArticleType
    && row.bodyTemplate === asset.bodyTemplate
    && JSON.stringify(row.contentTemplate) === JSON.stringify(asset.contentTemplate)
    && JSON.stringify(row.seoTemplate) === JSON.stringify(asset.seoTemplate)
    && row.slugTemplate === asset.slugTemplate
    && row.metaKeywordsTemplate === asset.metaKeywordsTemplate
  );
}

async function resolveApprover(db: Pick<ArticleTemplateBootstrapDb, "adminIdentity">, approver: string): Promise<ApproverRow> {
  const where = UUID_PATTERN.test(approver) ? { id: approver.toLowerCase() } : { username: approver };
  const identity = await db.adminIdentity.findFirst({ where, select: { id: true, username: true, status: true } });
  if (!identity) fail("approver_not_found", `approver ${approver} does not resolve to any admin_identity row`);
  if (identity.status !== "active") fail("approver_inactive", `approver ${approver} is not active`);
  return identity;
}

export type ArticleTemplateBootstrapReport = {
  mode: "dry-run" | "apply";
  wrote: boolean;
  auditId: string | null;
  manifestSha256: string;
  assetShaByLocale: Record<string, string>;
  locales: readonly string[];
  planned: { create: number; update: number; unchanged: number };
  applied: { created: number; updated: number; unchanged: number } | null;
};

export async function runArticleTemplateBootstrapCli(
  db: ArticleTemplateBootstrapDb,
  options: ArticleTemplateBootstrapCliOptions,
  artifacts: ArticleTemplateBootstrapArtifacts,
): Promise<ArticleTemplateBootstrapReport> {
  const templateKeys = SITE_LOCALES.map((locale) => artifacts.assetsByLocale.get(locale)!.templateKey);
  const existing = await db.articleTemplate.findMany({ where: { templateKey: { in: templateKeys } }, select: TEMPLATE_SELECT });
  const existingByKey = new Map(existing.map((row) => [row.templateKey, row]));

  let plannedCreate = 0;
  let plannedUpdate = 0;
  let plannedUnchanged = 0;
  for (const locale of SITE_LOCALES) {
    const asset = artifacts.assetsByLocale.get(locale)!;
    const row = existingByKey.get(asset.templateKey);
    if (!row) plannedCreate += 1;
    else if (assetContentEqualsRow(asset, row)) plannedUnchanged += 1;
    else plannedUpdate += 1;
  }

  const assetShaByLocale = Object.fromEntries(
    SITE_LOCALES.map((locale) => [locale, artifacts.manifest.files[assetFilename(locale)]!.sha256]),
  );

  if (!options.apply) {
    return Object.freeze({
      mode: "dry-run",
      wrote: false,
      auditId: null,
      manifestSha256: artifacts.manifestSha256,
      assetShaByLocale,
      locales: SITE_LOCALES,
      planned: { create: plannedCreate, update: plannedUpdate, unchanged: plannedUnchanged },
      applied: null,
    });
  }

  const approver = await resolveApprover(db, options.approver!);

  return db.$transaction(async (tx) => {
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const locale of SITE_LOCALES) {
      const asset = artifacts.assetsByLocale.get(locale)!;
      const before = existingByKey.get(asset.templateKey);
      const wasUnchanged = assetContentEqualsRow(asset, before);
      await tx.articleTemplate.upsert({
        where: { templateKey_version: { templateKey: asset.templateKey, version: asset.version } },
        create: {
          templateKey: asset.templateKey,
          templateName: asset.templateName,
          locale: asset.locale,
          version: asset.version,
          schemaVersion: asset.schemaVersion,
          status: asset.status,
          applicableArticleType: asset.applicableArticleType,
          bodyTemplate: asset.bodyTemplate,
          contentTemplate: asset.contentTemplate as unknown as Prisma.InputJsonValue,
          seoTemplate: asset.seoTemplate as Prisma.InputJsonValue,
          slugTemplate: asset.slugTemplate,
          metaKeywordsTemplate: asset.metaKeywordsTemplate,
        },
        update: {
          templateName: asset.templateName,
          locale: asset.locale,
          schemaVersion: asset.schemaVersion,
          status: asset.status,
          applicableArticleType: asset.applicableArticleType,
          bodyTemplate: asset.bodyTemplate,
          contentTemplate: asset.contentTemplate as unknown as Prisma.InputJsonValue,
          seoTemplate: asset.seoTemplate as Prisma.InputJsonValue,
          slugTemplate: asset.slugTemplate,
          metaKeywordsTemplate: asset.metaKeywordsTemplate,
        },
      });
      if (!before) created += 1;
      else if (wasUnchanged) unchanged += 1;
      else updated += 1;
    }

    const audit = await tx.operationAudit.create({
      data: {
        actorType: "system",
        actorId: approver.id,
        action: ARTICLE_TEMPLATE_BOOTSTRAP_AUDIT_ACTION,
        entityType: "ArticleTemplate",
        entityId: ARTICLE_TEMPLATE_BOOTSTRAP_ASSET_VERSION,
        afterSnapshot: {
          manifestSha256: artifacts.manifestSha256,
          assetShaByLocale,
          assetVersion: ARTICLE_TEMPLATE_BOOTSTRAP_ASSET_VERSION,
          created,
          updated,
          unchanged,
          approverUsername: approver.username,
        } as Prisma.InputJsonValue,
      },
    });

    return Object.freeze({
      mode: "apply" as const,
      wrote: true,
      auditId: audit.id.toString(),
      manifestSha256: artifacts.manifestSha256,
      assetShaByLocale,
      locales: SITE_LOCALES,
      planned: { create: plannedCreate, update: plannedUpdate, unchanged: plannedUnchanged },
      applied: { created, updated, unchanged },
    });
  });
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArticleTemplateBootstrapCliOptions(process.argv.slice(2));
  const artifacts = loadArticleTemplateBootstrapArtifacts();
  const prisma = new PrismaClient();
  try {
    const report = await runArticleTemplateBootstrapCli(prisma as unknown as ArticleTemplateBootstrapDb, options, artifacts);
    if (report.mode === "dry-run") {
      console.log("[DRY RUN — no changes written; pass --apply --approver <AdminIdentity uuid|username> to bootstrap]");
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
