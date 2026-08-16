#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CANONICAL_VERSION = "1.0.0";
const EXPECTED_BASELINE_SHA256 = "1ab0fd880efadcc244b8e4e03bcf1d440f200cfa85f6b12828e18914d0a7d0e6";
const EXPECTED_REVIEW_HASHES = Object.freeze({
  crossReviewReport: "20d65be8f11d65cc16e6196aca622e97fc5d45b15fcf6bdc323ad68fc18088d4",
  ownerReviewPackage: "fb50fce81abda949c4743a5da88534a659924a4cbfe8a3a2d1859dffe4910adf",
  newCanonicalReview: "4cbcbe21ed89ffcad540edbccbc38eacadc0203664ef9a3183f446ed2c9b0308",
  crossReviewMatrix: "1f1cf172b476d44841cbff234bbbfbd6b182ec7658496cbcba3da0f1cf1a134c",
});

const REMOVED_IDS = Object.freeze([
  "ct-v1-split:time-travel+rebirth",
  "ct-v1-power-dynamics-review",
  "ct-v1-mutual-first-experience-review",
]);

const NEW_CONCEPTS = Object.freeze([
  { slug: "male-audience", display: "男性向", aliases: ["男性向", "男频", "male audience", "male-audience"] },
  { slug: "lgbtq-romance", display: "LGBTQ+恋爱", aliases: ["LGBTQ+恋爱", "LGBTQ+", "LGBT+", "BL", "boys-love", "boys love", "耽美", "同性恋爱", "นิยายวาย"] },
  { slug: "supernatural", display: "灵异", aliases: ["灵异", "靈異", "supernatural", "paranormal"] },
  { slug: "horror", display: "恐怖", aliases: ["恐怖", "horror", "Horreur", "Ужасы", "ホラー", "공포"] },
  { slug: "historical-fiction", display: "历史题材", aliases: ["历史题材", "歷史題材", "历史架空", "歷史架空", "historical fiction"] },
  { slug: "gaming-esports", display: "游戏竞技", aliases: ["游戏竞技", "遊戲競技", "gaming", "esports", "e-sports"] },
  { slug: "xianxia", display: "仙侠修真", aliases: ["仙侠修真", "仙俠修真", "仙侠", "仙俠", "修仙", "修真", "xianxia"] },
]);

function fail(message) { throw new Error(`P2-06.5 Owner Final CanonicalTag: ${message}`); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export function parseCsv(text) {
  const source = text.replace(/^\uFEFF/u, "");
  const matrix = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n") { row.push(field.replace(/\r$/u, "")); matrix.push(row); row = []; field = ""; }
    else field += character;
  }
  if (quoted) fail("unterminated CSV quote");
  if (field.length > 0 || row.length > 0) { row.push(field); matrix.push(row); }
  const header = matrix.shift();
  if (!header?.length) fail("CSV is empty");
  return matrix.filter((cells) => cells.some(Boolean)).map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""])));
}

function unique(values) { return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))]; }

function normalizedAlias(value) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("und");
}

function convertBaselineTag(tag) {
  return {
    stable_id: tag.stable_id,
    slug: tag.slug,
    display_name_zh: tag["中文名"],
    canonical_definition: tag["定义"],
    translations: [{ locale: "zh", display_name: tag["中文名"] }],
    aliases: unique(tag.aliases ?? []),
    keyword_seeds: unique(tag.keywords ?? []),
    include_examples: [...(tag.include ?? [])],
    exclude_examples: [...(tag.exclude ?? [])],
    facet: tag.facet ?? "topic",
    locale_scope: "*",
    status: "public",
    source_ordinals: [...(tag.source_ordinals ?? [])],
    decision_ids: [...(tag.decision_ids ?? [])],
  };
}

function newTag(concept, review) {
  if (!review) fail(`missing cross-review row for ${concept.slug}`);
  const definition = concept.slug === "xianxia"
    ? "检索以修仙、修真、宗门、境界、渡劫、飞升、剑修等东方修炼体系为核心世界规则与成长主线的小说；它与泛东方奇幻独立。"
    : review.definition;
  const extraSeeds = concept.slug === "xianxia" ? ["宗门", "宗門", "境界", "渡劫", "飞升", "飛升", "剑修", "劍修"] : [];
  return {
    stable_id: `ct-v1-${concept.slug}`,
    slug: concept.slug,
    display_name_zh: concept.display,
    canonical_definition: definition,
    translations: [{ locale: "zh", display_name: concept.display }],
    aliases: unique(concept.aliases),
    keyword_seeds: unique([concept.display, ...concept.aliases, ...extraSeeds]),
    include_examples: [review.positive_boundary].filter(Boolean),
    exclude_examples: [review.negative_boundary].filter(Boolean),
    facet: concept.slug === "male-audience" ? "audience" : "topic",
    locale_scope: "*",
    status: "public",
    source_ordinals: [],
    decision_ids: [`OWNER-FINAL-${concept.slug.toUpperCase()}`],
  };
}

export function buildCanonicalTagV1Final({ candidate, newCanonicalReviewRows } = {}) {
  if (candidate?.candidate_count !== 119 || !Array.isArray(candidate.tags) || candidate.tags.length !== 119) fail("baseline must be Candidate 119");
  const baselineIds = new Set(candidate.tags.map(({ stable_id: id }) => id));
  for (const id of REMOVED_IDS) if (!baselineIds.has(id)) fail(`required workflow placeholder missing: ${id}`);
  const reviewBySlug = new Map(newCanonicalReviewRows.map((row) => [row.suggested_slug, row]));
  const tags = [
    ...candidate.tags.filter(({ stable_id: id }) => !REMOVED_IDS.includes(id)).map(convertBaselineTag),
    ...NEW_CONCEPTS.map((concept) => newTag(concept, reviewBySlug.get(concept.slug))),
  ].sort((left, right) => left.slug.localeCompare(right.slug, "en"));
  if (tags.length !== 123) fail(`expected structural result 123, found ${tags.length}`);
  const ids = tags.map(({ stable_id: id }) => id);
  const slugs = tags.map(({ slug }) => slug);
  if (new Set(ids).size !== ids.length) fail("stable_id is not unique");
  if (new Set(slugs).size !== slugs.length) fail("slug is not unique");
  if (slugs.includes("fanfiction")) fail("fanfiction is forbidden in CanonicalTag v1");
  if (!slugs.includes("xianxia") || !slugs.includes("eastern-fantasy")) fail("xianxia and eastern-fantasy must both exist");
  if (REMOVED_IDS.some((id) => ids.includes(id))) fail("workflow placeholder survived materialization");

  const aliases = new Map();
  for (const tag of tags) {
    for (const alias of [tag.slug, tag.display_name_zh, ...tag.aliases]) {
      const key = normalizedAlias(alias);
      const bucket = aliases.get(key) ?? new Set();
      bucket.add(tag.stable_id);
      aliases.set(key, bucket);
    }
  }
  const aliasCollisions = [...aliases.entries()]
    .filter(([, tagIds]) => tagIds.size > 1)
    .map(([normalized_alias, tagIds]) => ({ normalized_alias, stable_ids: [...tagIds].sort() }));
  if (aliasCollisions.length > 0) fail(`cross-tag alias collisions: ${JSON.stringify(aliasCollisions)}`);

  return {
    artifact_name: "P2-06.5 CanonicalTag v1 Owner Final",
    artifact_status: "FINAL",
    schema_version: 2,
    canonical_version: CANONICAL_VERSION,
    taxonomy_scope: "locale-independent-cross-language",
    count: tags.length,
    tags,
    qa: {
      stable_id_unique: true,
      slug_unique: true,
      alias_collision_count: aliasCollisions.length,
      alias_collisions: aliasCollisions,
    },
  };
}

async function writeAtomicDirectory(outputDir, files) {
  try { await lstat(outputDir); fail(`output directory already exists: ${outputDir}`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await mkdir(dirname(outputDir), { recursive: true });
  const staging = await mkdtemp(join(dirname(outputDir), `.${basename(outputDir)}.staging-`));
  try {
    for (const [name, content] of files) await writeFile(join(staging, name), content, { encoding: "utf8", flag: "wx" });
    await rename(staging, outputDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("arguments must be --name value pairs");
    options[key.slice(2)] = resolve(value);
  }
  for (const key of ["candidate", "new-canonical-review", "cross-review-matrix", "owner-review-package", "cross-review-report", "output-dir"]) {
    if (!options[key]) fail(`missing --${key}`);
  }
  return options;
}

export async function materializeCanonicalTagV1Final(options) {
  const inputPaths = {
    candidate: options.candidate,
    newCanonicalReview: options["new-canonical-review"],
    crossReviewMatrix: options["cross-review-matrix"],
    ownerReviewPackage: options["owner-review-package"],
    crossReviewReport: options["cross-review-report"],
  };
  const entries = await Promise.all(Object.entries(inputPaths).map(async ([name, path]) => [name, path, await readFile(path)]));
  const inputs = Object.fromEntries(entries.map(([name, path, bytes]) => [name, { path, bytes, sha256: sha256(bytes) }]));
  if (inputs.candidate.sha256 !== EXPECTED_BASELINE_SHA256) fail("Candidate 119 SHA-256 changed");
  for (const [name, expected] of Object.entries(EXPECTED_REVIEW_HASHES)) if (inputs[name].sha256 !== expected) fail(`${name} SHA-256 changed`);
  const candidate = JSON.parse(inputs.candidate.bytes.toString("utf8"));
  const reviewRows = parseCsv(inputs.newCanonicalReview.bytes.toString("utf8"));
  const canonical = buildCanonicalTagV1Final({ candidate, newCanonicalReviewRows: reviewRows });
  const artifactName = "canonical-tag-v1.0.0-final.json";
  const artifactContent = `${JSON.stringify(canonical, null, 2)}\n`;
  const artifactSha256 = sha256(Buffer.from(artifactContent));
  const generatedAt = new Date().toISOString();
  const manifest = {
    schema_version: 1,
    canonical_version: CANONICAL_VERSION,
    canonical_status: "FINAL",
    artifact_path: artifactName,
    artifact_sha256: artifactSha256,
    row_count: canonical.tags.length,
    stable_id_unique: canonical.qa.stable_id_unique,
    slug_unique: canonical.qa.slug_unique,
    removed_ids: [...REMOVED_IDS],
    added_ids: NEW_CONCEPTS.map(({ slug }) => `ct-v1-${slug}`),
    alias_collision_audit: canonical.qa,
    generated_at: generatedAt,
    source_evidence_versions: Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, { filename: basename(input.path), sha256: input.sha256 }])),
    superseded_artifact: { canonical_version: "1.0.0", count: 116, status: "SUPERSEDED_NOT_AN_INPUT" },
  };
  await writeAtomicDirectory(options["output-dir"], new Map([
    [artifactName, artifactContent],
    [`${artifactName}.sha256`, `${artifactSha256}  ${artifactName}\n`],
    ["CANONICAL_TAG_V1_MANIFEST.json", `${JSON.stringify(manifest, null, 2)}\n`],
  ]));
  return { canonical, manifest, artifactSha256, outputDir: options["output-dir"] };
}

async function main() {
  const result = await materializeCanonicalTagV1Final(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ CANONICAL_TAG_V1_STATUS: "FINAL", CANONICAL_TAG_V1_COUNT: result.canonical.tags.length, CANONICAL_TAG_V1_SHA256: result.artifactSha256, output_dir: result.outputDir }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

export { EXPECTED_REVIEW_HASHES, REMOVED_IDS, NEW_CONCEPTS };
