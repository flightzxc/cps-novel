/**
 * Test-only fixture seeder for `scripts/run-tagging-auto-preview-postgres-
 * verification.sh`. Never runs against a real (preprod/production) database
 * -- it is invoked by that shell script against a disposable, one-off
 * Postgres container only, using the `migration_owner` role.
 *
 * `scripts/tagging-auto-preview.ts` calls `resolveAutoClassificationAuthorities`
 * with no overrides, which means `loadKeywordRuleArtifactFromDb`
 * (`src/server/tagging/auto-classification.ts`) runs with its default
 * `enforceCanonicalV1: true` -- exactly like real production code (
 * `classifyNovelForAuto`) does. That default requires the database to
 * contain exactly the 123 real CanonicalTag v1 rows, and requires every
 * *enabled* `keyword-eligibility-v2` overlay rule to be matched by an actual
 * seeded keyword row (`applyKeywordEligibilityAuthority`'s
 * `requireEnabledRuleCoverage`). A handful of hand-written fixture tags (the
 * shape `tests/integration/tagging/*-postgres.test.ts` uses for testing the
 * *public projection*, not this classifier-authority loading path) would
 * fail both checks immediately, before the script under test ever reaches
 * its own logic.
 *
 * This seeder therefore loads the exact same hash-pinned, 123-tag production
 * artifact the real bootstrap CLI (`scripts/p2-06-5-production/
 * tagging-bootstrap.ts`) reads, and reuses that file's own pure, exported
 * `loadTaggingBootstrapArtifacts`/`buildCanonicalPlan` (keyword-eligibility
 * filtering already applied, byte-for-byte the same plan the real CLI would
 * write) to build the write plan, then writes it directly with the same
 * `canonicalTag`/`canonicalTagTranslation`/`canonicalTagKeyword` upsert
 * shapes that CLI's own (unexported) `writeCanonicalPlan` uses. It does NOT
 * run `runTaggingBootstrapCli` itself -- that orchestration also writes an
 * `AdminIdentity`-approved `OperationAudit` row this verification does not
 * need.
 *
 * A minimal, real `source_label_mapping` edge (one `Channel`/`SourceApp`/
 * `ChannelApp`/`AdminIdentity`/`SourceLabel`/`SourceLabelMapping` row, shared
 * across every seeded locale) is also written so this fixture can exercise
 * the SAME "eligible today (`NovelTagState.mode` is `automatic` or absent)
 * AND already has a mapped tag" case `loadPublicTaxonomyByNovelIds`'s
 * `base_membership` CTE reads in real production -- a manual
 * `NovelCanonicalTag(source: "manual")` row is a *different*, mutually
 * exclusive path (it only counts when `NovelTagState.mode = "manual"`,
 * which is never eligible for auto sampling), so it cannot stand in for
 * this case.
 *
 * Seeds, per locale in `--locales`:
 *  - 5 novels: eligible (`NovelTagState.mode = "automatic"`, explicit row)
 *    AND already mapped via the shared `source_label_mapping` edge to
 *    `ct-v1-adventure`. Two of the five also have "Adventure" in their title
 *    (the same tag's own keyword seed) so `pickBalancedSample`'s "mapped"
 *    pool is non-empty AND the run demonstrates the mapped/auto dedup path
 *    (a text-classifier candidate that duplicates an existing mapped tag
 *    must be dropped from `finalAutoTagsAfterDedup`).
 *  - 5 novels: eligible (explicit `automatic` row), unmapped. One has
 *    "Adventure" in its title -- a real production keyword seed
 *    (`ct-v1-adventure`, Latin script) -- so at least one *unmapped* sample
 *    also produces a non-empty classifier candidate end to end.
 *  - 5 novels: eligible (no `NovelTagState` row at all -- implicit
 *    automatic), unmapped.
 *  - 5 novels: `NovelTagState.mode = "manual"` with zero `NovelCanonicalTag`
 *    rows (a legal empty manual snapshot) -- counts toward the locale's
 *    total but must be excluded from both the mapped and the
 *    eligible-unmapped sampling pool.
 *
 * With `--boilerplate-locale <code>` (B-23) it additionally seeds six novels in
 * that ONE extra locale -- deliberately not in `--locales`, so the preview
 * run's fixed 20-per-locale pool arithmetic is untouched -- to exercise the
 * read-only rule-impact report (`tagging-backfill.ts --impact-report`):
 * publisher-template descriptions (the template sentences only, never a real
 * book's blurb) next to the real production keyword seed "Adventure".
 *
 * Usage: `DATABASE_URL=<migration_owner URL> npx tsx
 * scripts/tagging-auto-preview-fixtures.ts --locales en,ja
 * [--boilerplate-locale b23]`
 */
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import {
  buildCanonicalPlan,
  loadTaggingBootstrapArtifacts,
  TAGGING_BOOTSTRAP_KEYWORD_LEXICON_VERSION,
  TAGGING_BOOTSTRAP_TAXONOMY_VERSION,
} from "./p2-06-5-production/tagging-bootstrap";

const FIXTURE_RAW_LANGUAGE_SCOPE = "fixture-scope-v1";
const FIXTURE_RAW_TOKEN = "fixture-adventure-token";
const FIXTURE_SOURCE_LANGUAGE_CODE = "fixture-lang";

function requireLocales(argv: readonly string[]): string[] {
  const index = argv.indexOf("--locales");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  if (!raw) throw new Error("missing_argument: --locales");
  const locales = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (locales.length === 0) throw new Error("invalid_argument: --locales");
  return locales;
}

async function seedCanonicalTaxonomy(prisma: PrismaClient): Promise<Map<string, string>> {
  const artifacts = loadTaggingBootstrapArtifacts();
  const plan = buildCanonicalPlan(artifacts.canonical);
  const idByStableId = new Map<string, string>();
  for (const tag of plan.tags) {
    const row = await prisma.canonicalTag.create({
      data: {
        stableId: tag.stableId,
        slug: tag.slug,
        canonicalDefinition: tag.canonicalDefinition,
        aliases: tag.aliases,
        facet: tag.facet,
        status: "active",
        sortOrder: tag.sortOrder,
        taxonomyVersion: TAGGING_BOOTSTRAP_TAXONOMY_VERSION,
      },
      select: { id: true },
    });
    idByStableId.set(tag.stableId, row.id);
    for (const translation of tag.translations) {
      await prisma.canonicalTagTranslation.create({
        data: { canonicalTagId: row.id, locale: translation.locale, displayName: translation.displayName },
      });
    }
    for (const keyword of tag.keywords) {
      await prisma.canonicalTagKeyword.create({
        data: {
          keywordId: keyword.keywordId,
          canonicalTagId: row.id,
          value: keyword.value,
          scriptBuckets: keyword.scriptBuckets,
          matchMode: keyword.matchMode,
          riskFlags: [],
          active: true,
          lexiconVersion: TAGGING_BOOTSTRAP_KEYWORD_LEXICON_VERSION,
        },
      });
    }
  }
  return idByStableId;
}

interface MappingFixture {
  readonly channelAppId: string;
  readonly sourceLabelId: string;
}

/** One minimal, real `source_label_mapping` edge (`fixture-scope-v1`/`fixture-adventure-token` -> `ct-v1-adventure`), reused for every locale seeded below. */
async function seedSourceLabelMapping(prisma: PrismaClient, mappedTagId: string): Promise<MappingFixture> {
  const channel = await prisma.channel.create({
    data: { code: `fixture-channel-${randomUUID()}`, name: "Fixture Channel", status: "active" },
    select: { id: true },
  });
  const sourceApp = await prisma.sourceApp.create({
    data: { code: `fixture-source-app-${randomUUID()}`, name: "Fixture Source App", status: "active" },
    select: { id: true },
  });
  const channelApp = await prisma.channelApp.create({
    data: {
      channelId: channel.id,
      sourceAppId: sourceApp.id,
      externalAppId: `fixture-external-app-${randomUUID()}`,
      projectType: 1,
      status: "active",
    },
    select: { id: true },
  });
  const approver = await prisma.adminIdentity.create({
    data: {
      username: `fixture-approver-${randomUUID()}`,
      // admin_identity_password_hash_check requires the "scrypt$v1$" prefix
      // (prisma/migrations/20260804140000_p1_08b_admin_auth_persistence);
      // this identity is never used to authenticate, only as the FK target
      // for SourceLabelMapping.approvedBy, so the value after the prefix is
      // never parsed as a real hash.
      passwordHash: "scrypt$v1$fixture-not-a-real-hash",
      role: "admin",
      status: "active",
    },
    select: { id: true },
  });
  const sourceLabel = await prisma.sourceLabel.create({
    data: { channelAppId: channelApp.id, labelKind: "series_type", externalLabelValue: FIXTURE_RAW_TOKEN },
    select: { id: true },
  });
  await prisma.sourceLabelMapping.create({
    data: {
      channelAppId: channelApp.id,
      rawLanguageScope: FIXTURE_RAW_LANGUAGE_SCOPE,
      rawToken: FIXTURE_RAW_TOKEN,
      canonicalTagId: mappedTagId,
      mappingVersion: "fixture-mapping-v1",
      active: true,
      approvedBy: approver.id,
    },
  });
  return { channelAppId: channelApp.id, sourceLabelId: sourceLabel.id };
}

async function seedNovelsForLocale(
  prisma: PrismaClient,
  locale: string,
  mapping: MappingFixture,
): Promise<void> {
  let ordinal = 0;
  // This create call deliberately does not set a publication-status field --
  // tests/backend/publish-gate/no-bypass.test.ts fails closed on any
  // .novel.create() call whose argument list contains that key at all
  // (literal or commented), outside src/server/publish-gate/. The Novel
  // model's own schema default already gives every fixture row here the
  // value it needs.
  const nextNovel = async (title: string, description: string) => {
    ordinal += 1;
    return prisma.novel.create({
      data: {
        businessId: `fixture-tagging-auto-preview-${locale}-${ordinal}-${randomUUID()}`,
        title,
        description,
        locale,
        slug: `fixture-tagging-auto-preview-${locale}-${ordinal}`,
      },
      select: { id: true },
    });
  };
  const linkMappedSourceItem = async (novelId: string) => {
    const sourceItem = await prisma.novelSourceItem.create({
      data: {
        channelAppId: mapping.channelAppId,
        novelId,
        externalBookId: `fixture-book-${locale}-${ordinal}-${randomUUID()}`,
        sourceLanguageCode: FIXTURE_SOURCE_LANGUAGE_CODE,
        sourceLocale: locale,
        rawLanguageScope: FIXTURE_RAW_LANGUAGE_SCOPE,
        title: "fixture source title",
        description: "fixture source description",
        status: "linked",
        rawPayload: {},
      },
      select: { id: true },
    });
    await prisma.novelSourceItemLabel.create({
      data: { novelSourceItemId: sourceItem.id, sourceLabelId: mapping.sourceLabelId, active: true },
    });
  };

  // Group A: eligible (explicit automatic) AND mapped via source_label_mapping.
  for (let i = 0; i < 5; i += 1) {
    const title = i < 2 ? `An Adventure returns in ${locale} ${i}` : `Fixture mapped eligible ${locale} ${i}`;
    const novel = await nextNovel(title, "A quiet slice-of-life story with no special keywords.");
    await prisma.novelTagState.create({ data: { novelId: novel.id, mode: "automatic" } });
    await linkMappedSourceItem(novel.id);
  }

  // Group B: explicit automatic tag-state row, unmapped, eligible.
  for (let i = 0; i < 5; i += 1) {
    const title = i === 0 ? `An Adventure begins in ${locale}` : `Fixture unmapped explicit ${locale} ${i}`;
    const novel = await nextNovel(title, "A story about growing up and making new friends.");
    await prisma.novelTagState.create({ data: { novelId: novel.id, mode: "automatic" } });
  }

  // Group C: no tag-state row at all -- implicit automatic, unmapped, eligible.
  for (let i = 0; i < 5; i += 1) {
    await nextNovel(`Fixture unmapped implicit ${locale} ${i}`, "A mystery unfolds in a small coastal town.");
  }

  // Group D: manual FULL_SNAPSHOT that is legally empty -- counts toward the
  // locale total, excluded from both the mapped and the eligible pool.
  for (let i = 0; i < 5; i += 1) {
    const novel = await nextNovel(`Fixture manual empty ${locale} ${i}`, "An empty manual snapshot fixture.");
    await prisma.novelTagState.create({ data: { novelId: novel.id, mode: "manual" } });
  }
}

// Expected `--impact-report --locale <code>` result for the six novels below,
// kept next to the data so the runner and this fixture cannot drift apart.
const BOILERPLATE_FIXTURE_EXPECTED = {
  novelsScanned: 6,
  novelsManualSkipped: 1,
  novelsEligible: 5,
  novelsBoilerplateMatched: 4,
  novelsChanged: 1,
  novelsScoreOnlyChanged: 1,
  novelsLosingAllAutoTags: 1,
  tagsRemoved: 1,
  tagsAdded: 0,
  patternHits: { "bp-001": 3, "bp-008": 1 },
} as const;

async function seedBoilerplateNovels(prisma: PrismaClient, locale: string): Promise<void> {
  const create = async (n: number, title: string, description: string, mode?: "manual") => {
    const novel = await prisma.novel.create({
      data: {
        businessId: `fixture-tagging-b23-${locale}-${n}-${randomUUID()}`,
        title,
        description,
        locale,
        slug: `fixture-tagging-b23-${locale}-${n}`,
      },
      select: { id: true },
    });
    if (mode) await prisma.novelTagState.create({ data: { novelId: novel.id, mode } });
  };
  const template = "This work has been selected by scholars as being culturally important and is part of the knowledge base of civilization as we know it.";
  // 1: boilerplate + keyword only in the description -> loses its only auto tag
  await create(1, "Fixture boilerplate loses tag", `${template} A tale of Adventure.`);
  // 2: boilerplate under a different pattern (start-anchored), keyword only in the title -> unchanged
  await create(2, "Fixture Adventure title", "Excerpt from a long forgotten volume.");
  // 3: ordinary description with the keyword -> not matched, untouched
  await create(3, "Fixture ordinary", "A tale of Adventure on the high seas.");
  // 4: manual mode + boilerplate -> never reclassified, never counted as changed
  await create(4, "Fixture manual boilerplate", `${template} A tale of Adventure.`, "manual");
  // 5: typographic dressing, keyword in title AND description -> same tag, score 60 -> 30
  await create(5, "Fixture Adventure both", `${template.toUpperCase().replace("AS BEING", "AS\u00a0BEING")} It\u2019s an ADVENTURE.`);
  // 6: boilerplate with no keywords at all -> matched, nothing to change
  await create(6, "Fixture bare boilerplate", template);
}

async function main(): Promise<void> {
  const locales = requireLocales(process.argv.slice(2));
  const boilerplateLocaleIndex = process.argv.indexOf("--boilerplate-locale");
  const boilerplateLocale = boilerplateLocaleIndex >= 0 ? process.argv[boilerplateLocaleIndex + 1] : undefined;
  const prisma = new PrismaClient();
  try {
    const idByStableId = await seedCanonicalTaxonomy(prisma);
    const mappedTagId = idByStableId.get("ct-v1-adventure");
    if (!mappedTagId) throw new Error("fixture_setup_failed: ct-v1-adventure not found in canonical plan");
    const mapping = await seedSourceLabelMapping(prisma, mappedTagId);
    for (const locale of locales) {
      await seedNovelsForLocale(prisma, locale, mapping);
    }
    if (boilerplateLocale) await seedBoilerplateNovels(prisma, boilerplateLocale);
    console.log(JSON.stringify({
      result: "TAGGING_AUTO_PREVIEW_FIXTURES_OK",
      canonicalTagCount: idByStableId.size,
      locales,
      novelsPerLocale: 20,
      ...(boilerplateLocale ? { boilerplateLocale, boilerplateNovels: 6, boilerplateExpectedImpact: BOILERPLATE_FIXTURE_EXPECTED } : {}),
    }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 64;
});
