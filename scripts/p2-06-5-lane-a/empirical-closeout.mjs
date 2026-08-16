#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const VERSION = "1.0.0";
const DECISION_DATE = "2026-08-16";
const EXPECTED_BASELINE_COUNT = 119;
const EXPECTED_FINAL_COUNT = 116;
const RAW_RUN_ID = "2026-08-15-changdu-real-b1-v2";

function fail(message) {
  throw new Error(`P2-06.5 Lane A closeout failed: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) fail("arguments must be --name value pairs");
    if (args.has(name)) fail(`duplicate argument ${name}`);
    args.set(name, value);
  }
  for (const required of ["--a-source-dir", "--b1-raw-dir", "--b1-derived-dir", "--output-dir"]) {
    if (!args.has(required)) fail(`missing ${required}`);
  }
  return {
    aSourceDir: resolve(args.get("--a-source-dir")),
    b1RawDir: resolve(args.get("--b1-raw-dir")),
    b1DerivedDir: resolve(args.get("--b1-derived-dir")),
    outputDir: resolve(args.get("--output-dir")),
  };
}

function parseCsv(text) {
  const source = text.replace(/^\uFEFF/u, "");
  const matrix = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/u, ""));
      matrix.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) fail("unterminated CSV quote");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    matrix.push(row);
  }
  const header = matrix.shift();
  if (!header?.length) fail("CSV is empty");
  return matrix
    .filter((cells) => cells.some((cell) => cell.length > 0))
    .map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""])));
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rowsToCsv(columns, rows) {
  return `${[columns, ...rows.map((row) => columns.map((column) => row[column]))]
    .map((row) => row.map(csvCell).join(","))
    .join("\n")}\n`;
}

function parseJsonLines(text, label) {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        fail(`${label} line ${index + 1} is not JSON`);
      }
    });
}

function exactTokenCount(books, token) {
  return books.filter((book) => Array.isArray(book.seriesTypeListRaw) && book.seriesTypeListRaw.includes(token)).length;
}

function searchableText(book) {
  return `${typeof book.titleRaw === "string" ? book.titleRaw : ""}\n${typeof book.descriptionRaw === "string" ? book.descriptionRaw : ""}`;
}

function phraseCount(books, pattern) {
  return books.filter((book) => pattern.test(searchableText(book))).length;
}

function requireEvidenceBooks(bookById, ids, label) {
  return ids.map((id) => {
    const book = bookById.get(id);
    if (!book) fail(`${label} evidence book ${id} is not in the final 10,000 sample`);
    return {
      external_book_id: id,
      title: book.titleRaw,
      raw_language: book.languageJsonValue,
      raw_tokens: book.seriesTypeListRaw,
      description_excerpt: typeof book.descriptionRaw === "string"
        ? book.descriptionRaw.replace(/\s+/gu, " ").trim().slice(0, 240)
        : null,
    };
  });
}

function overlayOwnerCorrection(baseRows, deltaRows) {
  const deltaBySourceTag = new Map(deltaRows.map((row) => [row.source_tag, row]));
  return baseRows.map((row) => {
    const delta = deltaBySourceTag.get(row.source_tag);
    return {
      ...row,
      final_disposition: delta?.new_primary_disposition || row.final_disposition,
      final_slug: delta?.canonical_target || row.proposed_slug,
      final_name_zh: delta?.canonical_name_zh || row.proposed_name_zh,
      final_facet: delta?.target_facet || row.target_facet || "topic",
      owner_correction_ids: delta?.relation_decision_ids || "",
    };
  });
}

function applyEmpiricalCloseout(rows) {
  return rows.map((row) => {
    if (row.source_tag === "office-tension" || row.source_tag === "office-romance") {
      return { ...row, final_disposition: "KEEP_SEPARATE", empirical_decision_id: "A-EMP-01" };
    }
    if (row.source_tag === "future-world" || row.source_tag === "sci-fi-world") {
      return { ...row, final_disposition: "KEEP_SEPARATE", empirical_decision_id: "A-EMP-02" };
    }
    if (row.source_tag === "student") {
      return {
        ...row,
        final_disposition: "MERGE_RECOMMENDED",
        final_slug: "campus",
        final_name_zh: "校园",
        empirical_decision_id: "A-EMP-03",
      };
    }
    if (row.source_tag === "campus") {
      return { ...row, final_disposition: "MERGE_RECOMMENDED", empirical_decision_id: "A-EMP-03" };
    }
    if (row.source_tag === "both-virgin") {
      return {
        ...row,
        final_disposition: "DROP_RECOMMENDED",
        final_slug: "",
        empirical_decision_id: "A-EMP-LV-01",
      };
    }
    if (row.source_tag === "power-play") {
      return {
        ...row,
        final_disposition: "DROP_RECOMMENDED",
        final_slug: "",
        empirical_decision_id: "A-EMP-LV-02",
      };
    }
    return row;
  });
}

const SPECIAL_DEFINITIONS = Object.freeze({
  "office-tension": {
    definition: "检索以职场竞争、权力不对等、伦理冲突或敌对合作为核心张力的小说；恋爱不是必要条件。",
    include: ["主线由同事、上下级或商业对手之间的职场冲突推动。"],
    exclude: ["只有恋爱发生在办公室、但职场冲突不构成主要阅读期待的作品。"],
  },
  "office-romance": {
    definition: "检索核心恋爱关系在工作场所或职业合作关系中形成并持续推进的小说。",
    include: ["老板与助理、同事或职业合作伙伴之间的恋爱是主线。"],
    exclude: ["仅有办公室场景或纯职场竞争、没有核心恋爱关系的作品。"],
  },
  "future-world": {
    definition: "检索主要故事世界处于相对叙事当下的未来时期，未来社会或未来环境是核心设定的小说。",
    include: ["主要情节持续发生在未来社会、未来地球或未来文明。"],
    exclude: ["角色仅来自未来、但主体故事发生在古代或当代的作品；未明确未来设定的当代科幻。"],
  },
  "science-fiction": {
    definition: "检索以科学、技术、宇宙、人工智能或推演性世界规则为核心设定的科幻小说，不限定发生时代。",
    include: ["科技或科学推演对主要冲突和世界规则具有实质影响。"],
    exclude: ["只有未来字样但缺乏科幻机制的作品；纯奇幻或仅角色来自未来的古代故事。"],
  },
  campus: {
    definition: "检索以学校、大学、校园生活及学生阶段关系为主要故事场景和阅读期待的小说。",
    include: ["高中或大学生活、同学关系、学生成长、校园恋爱或校园事件构成主线。"],
    exclude: ["人物只是具有学生身份、但主体情节不发生于学校或学生生活的作品。"],
  },
});

function canonicalDefinition(group) {
  const special = SPECIAL_DEFINITIONS[group.slug];
  if (special) return special;
  const displayName = group.displayName;
  const aliases = group.sourceNames.join(" / ");
  const facetText = group.facet === "topic" ? "题材、设定或人物原型" : `${group.facet} 筛选属性`;
  return {
    definition: `用于检索以“${displayName}”为核心${facetText}的小说；该概念必须对主线或用户选择结果具有实质影响。`,
    include: [`主线明确体现“${displayName}”（来源别名：${aliases}）的作品。`],
    exclude: [`仅在标题或简介中偶然提及“${displayName}”、但不影响主要情节或筛选期待的作品。`],
  };
}

function buildCanonicalArtifact(rows) {
  const kept = rows.filter((row) => !new Set(["DROP_RECOMMENDED", "DECOMPOSE_TO_ATOMS"]).has(row.final_disposition));
  if (kept.some((row) => !row.final_slug)) fail("retained source row has no canonical slug");
  const groups = Map.groupBy(kept, (row) => row.final_slug);
  if (groups.size !== EXPECTED_FINAL_COUNT) fail(`expected ${EXPECTED_FINAL_COUNT} final tags, found ${groups.size}`);
  const tags = [...groups.entries()]
    .map(([slug, groupRows]) => {
      const displayNames = [...new Set(groupRows.map((row) => row.final_name_zh))];
      if (displayNames.length !== 1) fail(`${slug} has conflicting display names: ${displayNames.join("|")}`);
      const facets = [...new Set(groupRows.map((row) => row.final_facet || "topic"))];
      if (facets.length !== 1) fail(`${slug} has conflicting facets: ${facets.join("|")}`);
      const group = {
        slug,
        displayName: displayNames[0],
        facet: facets[0],
        sourceNames: [...new Set(groupRows.map((row) => row.source_name))],
      };
      const definition = canonicalDefinition(group);
      return {
        canonical_tag_id: `ct-v1-${slug}`,
        slug,
        display_name: group.displayName,
        locale_scope: "*",
        definition: definition.definition,
        include: definition.include,
        exclude: definition.exclude,
        status: "public",
        facet: group.facet,
        aliases: [...new Set(groupRows.flatMap((row) => [row.source_tag, row.source_name]))],
        source_ordinals: groupRows.map((row) => Number(row.ordinal)).sort((left, right) => left - right),
        decision_ids: [...new Set(groupRows.flatMap((row) => [row.owner_correction_ids, row.empirical_decision_id]
          .filter(Boolean)
          .flatMap((value) => value.split("|").filter(Boolean))))],
      };
    })
    .sort((left, right) => left.slug.localeCompare(right.slug, "en"));
  return {
    schema_version: 1,
    canonical_version: VERSION,
    decision_date: DECISION_DATE,
    taxonomy_scope: "cross-language",
    count_includes_facet_values: true,
    tags,
  };
}

function buildDecisionEvidence(finalBooks, bookById) {
  const officePositiveIds = [31927497, 470747970, 5593250];
  const officeCounterIds = [113848680, 5598417];
  const futureCounterIds = [1075322689, 1075328862, 5604553, 186675186];
  const campusPositiveIds = [5610480, 5610484, 248122964];
  const campusNoiseIds = [186674204, 1075326139];
  const powerPlayIds = [77465256, 576636506];

  const exactTokens = new Set(finalBooks.flatMap((book) => Array.isArray(book.seriesTypeListRaw)
    ? book.seriesTypeListRaw.filter((token) => typeof token === "string")
    : []));
  const genericVirginMentions = phraseCount(finalBooks, /\bvirgins?\b|处女|處女/iu);
  const mutualVirginMentions = phraseCount(finalBooks, /both virgins|two virgins|each other['’]s first|双处|雙處/iu);

  return {
    decisions: [
      {
        decision_id: "A-EMP-01",
        source_tags: ["office-tension", "office-romance"],
        final_decision: "KEEP_SEPARATE",
        canonical_targets: ["office-tension", "office-romance"],
        aliases: [],
        count_effect: 0,
        evidence_summary: "Office evidence contains genuine workplace romance and non-romantic workplace competition/adventure. Merging pure office tension into romance would create a materially wrong result set.",
        evidence_metrics: {
          exact_office_romance_phrase_books: phraseCount(finalBooks, /office romance/iu),
          office_mention_books: phraseCount(finalBooks, /office/iu),
          exact_source_tokens_present: ["Office Tension", "Office Romance"].filter((token) => exactTokens.has(token)),
        },
        representative_books: [
          ...requireEvidenceBooks(bookById, officePositiveIds, "office positive"),
          ...requireEvidenceBooks(bookById, officeCounterIds, "office counterexample"),
        ],
      },
      {
        decision_id: "A-EMP-02",
        source_tags: ["future-world", "sci-fi-world"],
        final_decision: "KEEP_SEPARATE",
        canonical_targets: ["future-world", "science-fiction"],
        aliases: [],
        count_effect: 0,
        evidence_summary: "Three future-world mentions lead into ancient rebirth or campus stories, while a Sci-fi-labelled contemporary relationship experiment is not a future-world setting. Neither direction of the result-set test is safe.",
        evidence_metrics: {
          future_world_phrase_books: phraseCount(finalBooks, /future world|未来世界|未來世界/iu),
          exact_sci_fi_token_books: ["Sci-fi", "Sci-Fi", "Science-fiction"]
            .reduce((sum, token) => sum + exactTokenCount(finalBooks, token), 0),
        },
        representative_books: requireEvidenceBooks(bookById, futureCounterIds, "future/science-fiction counterexample"),
      },
      {
        decision_id: "A-EMP-03",
        source_tags: ["student", "campus"],
        final_decision: "MERGE_WITH_ALIAS",
        canonical_targets: ["campus"],
        aliases: ["student", "Student"],
        count_effect: -1,
        evidence_summary: "Stable positive examples are school/campus stories, while Young Adult and Adolescent buckets contain adult and mislabelled works. A separate Student retrieval entry would not reliably improve results; Campus carries the user-facing intent and Student remains an alias.",
        evidence_metrics: {
          simplified_campus_token_books: exactTokenCount(finalBooks, "青春校园"),
          traditional_campus_token_books: exactTokenCount(finalBooks, "青春校園"),
          young_adult_token_books: exactTokenCount(finalBooks, "Young Adult") + exactTokenCount(finalBooks, "young adult"),
          adolescent_token_books: exactTokenCount(finalBooks, "Adolescent"),
          exact_source_tokens_present: ["Student", "Campus"].filter((token) => exactTokens.has(token)),
        },
        representative_books: [
          ...requireEvidenceBooks(bookById, campusPositiveIds, "campus positive"),
          ...requireEvidenceBooks(bookById, campusNoiseIds, "campus bucket noise"),
        ],
      },
      {
        decision_id: "A-EMP-LV-01",
        source_tags: ["both-virgin"],
        final_decision: "DROP_LOW_VALUE",
        canonical_targets: [],
        aliases: [],
        count_effect: -1,
        evidence_summary: "No exact source token or explicit mutual-first-experience phrase appears in the accepted 10k sample. Generic virgin mentions do not prove both protagonists share a first experience, so the entry is too fragile and sensitive for Canonical v1.",
        evidence_metrics: {
          exact_source_token_books: exactTokenCount(finalBooks, "Both Virgin"),
          explicit_mutual_first_experience_books: mutualVirginMentions,
          generic_virgin_mention_books: genericVirginMentions,
        },
        representative_books: [],
      },
      {
        decision_id: "A-EMP-LV-02",
        source_tags: ["power-play"],
        final_decision: "DROP_LOW_VALUE",
        canonical_targets: [],
        aliases: [],
        count_effect: -1,
        evidence_summary: "No exact Power Play source token appears. Both literal phrase matches describe explicit dominance/BDSM dynamics rather than a stable political, business, or court-intrigue retrieval concept; merging them elsewhere would be materially wrong.",
        evidence_metrics: {
          exact_source_token_books: exactTokenCount(finalBooks, "Power Play"),
          literal_phrase_books: phraseCount(finalBooks, /power play/iu),
        },
        representative_books: requireEvidenceBooks(bookById, powerPlayIds, "power-play"),
      },
    ],
  };
}

function languageResolution(finalBooks, languageValue) {
  const books = finalBooks.filter((book) => book.languageJsonValue === languageValue);
  if (books.length === 0) fail(`raw language ${languageValue} has no final books`);
  const names = [...new Set(books.map((book) => JSON.stringify(book.sourceLanguageNameRaw)))];
  const tokens = new Map();
  for (const book of books) {
    for (const token of Array.isArray(book.seriesTypeListRaw) ? book.seriesTypeListRaw : []) {
      if (typeof token === "string") tokens.set(token, (tokens.get(token) ?? 0) + 1);
    }
  }
  const rawScopes = [...new Set(books.map((book) => book.rawLanguageScope))];
  if (rawScopes.length !== 1) fail(`raw language ${languageValue} has multiple exact raw scopes`);
  const likelyScript = languageValue === 19 ? "Simplified Chinese (likely, not proven locale)" : "Traditional Chinese (likely, not proven locale)";
  return {
    raw_language_json_value: languageValue,
    exact_raw_scope: rawScopes[0],
    source_language_name_values: names,
    final_sample_books: books.length,
    distinct_exact_tokens: tokens.size,
    top_exact_tokens: [...tokens.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 15)
      .map(([token, frequency]) => ({ token, frequency })),
    script_inference: likelyScript,
    resolution: "RAW_SCOPE_ONLY",
    canonical_locale: null,
    c1_locale_specific_statistics: "BLOCKED",
    reason: "languageName is null and no repository or upstream registry proves an exact locale/region mapping. Script evidence is insufficient to assign BCP-47 or a region.",
  };
}

function decisionRows(evidence) {
  return evidence.decisions.map((decision) => ({
    decision_id: decision.decision_id,
    source_tags: decision.source_tags.join("|"),
    final_decision: decision.final_decision,
    canonical_targets: decision.canonical_targets.join("|"),
    aliases: decision.aliases.join("|"),
    count_effect: decision.count_effect,
    evidence_metrics_json: JSON.stringify(decision.evidence_metrics),
    sample_book_ids: decision.representative_books.map((book) => book.external_book_id).join("|"),
    rationale: decision.evidence_summary,
  }));
}

function renderReport({ canonical, canonicalSha, evidence, languages, sources, b1RawManifest, b1DerivedManifest, timingViolations }) {
  const decisionById = new Map(evidence.decisions.map((decision) => [decision.decision_id, decision]));
  const office = decisionById.get("A-EMP-01");
  const future = decisionById.get("A-EMP-02");
  const campus = decisionById.get("A-EMP-03");
  const bothVirgin = decisionById.get("A-EMP-LV-01");
  const powerPlay = decisionById.get("A-EMP-LV-02");
  const lang19 = languages.find((language) => language.raw_language_json_value === 19);
  const lang20 = languages.find((language) => language.raw_language_json_value === 20);
  const bookLines = (decision) => decision.representative_books
    .map((book) => `- \`${book.external_book_id}\` · ${book.title} · raw tokens \`${JSON.stringify(book.raw_tokens)}\``)
    .join("\n");
  return `# P2-06.5 Gate A · Empirical Closeout\n\n` +
    `Decision date: ${DECISION_DATE}\n\n` +
    `## Outcome\n\n` +
    `CanonicalTag v1 is **FINAL at ${canonical.tags.length} entries**. The previous 119-entry candidate set closes at 116: \`student\` merges into \`campus\` as an alias, while \`both-virgin\` and \`power-play\` are dropped from v1. Office Tension and Office Romance remain separate; Future World and Science Fiction remain separate. No frozen decision was reopened.\n\n` +
    `B1 remains authoritatively \`PARTIAL\`. Owner accepted this one run with a timing waiver because all 240 pages succeeded, there were no retries or 429s, semantic round-trip passed, and the final sample contains 10,000 books. The six 999ms request-start intervals remain visible in the source run; this report does not change the global >=1000ms contract.\n\n` +
    `Timing violations (previous attempt → next attempt): ${timingViolations.map((item) => `${item.previous_attempt}→${item.next_attempt} (${item.interval_ms}ms)`).join(", ")}.\n\n` +
    `## Closed merge reviews\n\n` +
    `### Office Tension / Office Romance — KEEP_SEPARATE\n\n` +
    `${office.evidence_summary} The sample has ${office.evidence_metrics.office_mention_books} books mentioning “office”, but only ${office.evidence_metrics.exact_office_romance_phrase_books} explicit “office romance” phrase match.\n\n` +
    `${bookLines(office)}\n\n` +
    `### Future World / Science Fiction — KEEP_SEPARATE\n\n` +
    `${future.evidence_summary} The accepted sample contains ${future.evidence_metrics.future_world_phrase_books} future-world phrase matches and ${future.evidence_metrics.exact_sci_fi_token_books} books carrying the listed exact English Sci-fi variants.\n\n` +
    `${bookLines(future)}\n\n` +
    `### Student / Campus — MERGE + ALIAS\n\n` +
    `${campus.evidence_summary} Evidence buckets contain ${campus.evidence_metrics.simplified_campus_token_books} \`青春校园\`, ${campus.evidence_metrics.traditional_campus_token_books} \`青春校園\`, ${campus.evidence_metrics.young_adult_token_books} Young Adult variants, and ${campus.evidence_metrics.adolescent_token_books} Adolescent books.\n\n` +
    `${bookLines(campus)}\n\n` +
    `## Closed low-value reviews\n\n` +
    `- **Both Virgin — DROP_LOW_VALUE.** ${bothVirgin.evidence_summary} Explicit mutual-first-experience matches: ${bothVirgin.evidence_metrics.explicit_mutual_first_experience_books}; generic virgin mentions: ${bothVirgin.evidence_metrics.generic_virgin_mention_books}.\n` +
    `- **Power Play — DROP_LOW_VALUE.** ${powerPlay.evidence_summary}\n\n` +
    `${bookLines(powerPlay)}\n\n` +
    `## Raw language identities 19 and 20\n\n` +
    `Neither raw numeric value has an upstream \`languageName\` or a repository registry entry. The observed character forms are strongly suggestive but do not prove a locale or region. They therefore remain exact raw scopes, and locale-specific C1 statistics are blocked.\n\n` +
    `| raw language | final books | exact tokens | evidence | resolution | C1 locale stats |\n` +
    `| ---: | ---: | ---: | --- | --- | --- |\n` +
    `| 19 | ${lang19.final_sample_books} | ${lang19.distinct_exact_tokens} | Simplified-script tokens such as 现代言情 / 青春校园 / 总裁豪门 | RAW_SCOPE_ONLY | BLOCKED |\n` +
    `| 20 | ${lang20.final_sample_books} | ${lang20.distinct_exact_tokens} | Traditional-script tokens such as 現代言情 / 青春校園 / 總裁豪門 | RAW_SCOPE_ONLY | BLOCKED |\n\n` +
    `The closeout does not guess \`zh-CN\`, \`zh-TW\`, \`zh-Hans\`, or \`zh-Hant\`. A future locale mapping needs exact upstream documentation or an Owner-approved registry.\n\n` +
    `## Versioned artifact\n\n` +
    `- Canonical version: \`${canonical.canonical_version}\`\n` +
    `- CanonicalTag count: \`${canonical.tags.length}\` (including the previously counted 7 facet values)\n` +
    `- Artifact: \`canonical-tag-v1.0.0.json\`\n` +
    `- SHA-256: \`${canonicalSha}\`\n` +
    `- Scope: cross-language canonical concepts; raw source-language scope remains a separate B2 mapping-key component.\n\n` +
    `B2 was not executed. No database, schema, migration, classifier configuration, SourceLabelMapping, Worker, Scheduler, or business code was modified.\n\n` +
    `## Evidence lineage and limitations\n\n` +
    `- B1 raw manifest: run \`${b1RawManifest.run_id}\`, status \`${b1RawManifest.status}\`, SHA-256 \`${sources.b1_raw_manifest_sha256}\`.\n` +
    `- B1 derived manifest: status \`${b1DerivedManifest.laneBSampleStatus}\`, raw round-trip \`${b1DerivedManifest.rawRoundTripQaPassed}\`, SHA-256 \`${sources.b1_derived_manifest_sha256}\`.\n` +
    `- Prior A tag coverage SHA-256: \`${sources.tag_coverage_sha256}\`.\n` +
    `- Owner correction delta SHA-256: \`${sources.owner_correction_delta_sha256}\`.\n` +
    `- This is evidence-based taxonomy closeout, not a prevalence estimate. Missing exact source tokens are negative evidence for v1 mapping readiness, not proof that a concept never occurs.\n\n` +
    `## Fixed status block\n\n` +
    `\`\`\`text\n` +
    `CANONICAL_TAG_V1_COUNT=${canonical.tags.length}\n` +
    `A_REMAINING_MERGE_REVIEWS=0\n` +
    `A_REMAINING_LOW_VALUE_REVIEWS=0\n` +
    `LANGUAGE_19_RESOLUTION=RAW_SCOPE_ONLY_LIKELY_SIMPLIFIED_CHINESE_C1_LOCALE_STATS_BLOCKED\n` +
    `LANGUAGE_20_RESOLUTION=RAW_SCOPE_ONLY_LIKELY_TRADITIONAL_CHINESE_C1_LOCALE_STATS_BLOCKED\n` +
    `CANONICAL_TAG_V1_STATUS=FINAL\n` +
    `\`\`\`\n`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHtmlReport({ canonical, canonicalSha, evidence, languages, timingViolations }) {
  const rows = evidence.decisions.map((decision) => `<tr><td><code>${escapeHtml(decision.decision_id)}</code></td><td>${escapeHtml(decision.source_tags.join(" / "))}</td><td>${escapeHtml(decision.final_decision)}</td><td>${escapeHtml(decision.canonical_targets.join(" / ") || "—")}</td><td>${decision.count_effect}</td></tr>`).join("");
  const languageRows = languages.map((language) => `<tr><td>${language.raw_language_json_value}</td><td>${language.final_sample_books.toLocaleString("en-US")}</td><td>${language.distinct_exact_tokens}</td><td><code>RAW_SCOPE_ONLY</code></td><td><strong>BLOCKED</strong></td></tr>`).join("");
  const timing = timingViolations.map((item) => `<li>attempt ${item.previous_attempt} → ${item.next_attempt}: <strong>${item.interval_ms}ms</strong></li>`).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>P2-06.5 Gate A Empirical Closeout</title>
  <style>
    :root { color-scheme: light; --ink:#172033; --muted:#5f6b7a; --line:#dfe4ec; --blue:#2457d6; --soft:#f5f7fb; --good:#0f766e; --warn:#a16207; }
    * { box-sizing:border-box; } body { margin:0; background:#eef2f7; color:var(--ink); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { max-width:1040px; margin:32px auto; background:#fff; border:1px solid var(--line); border-radius:18px; box-shadow:0 18px 50px rgba(27,39,66,.08); padding:42px; }
    h1 { font-size:30px; margin:0 0 8px; } h2 { margin-top:36px; font-size:20px; } p { color:var(--muted); }
    .eyebrow { color:var(--blue); font-weight:700; letter-spacing:.08em; text-transform:uppercase; font-size:12px; }
    .cards { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin:26px 0; }
    .card { padding:18px; border:1px solid var(--line); border-radius:12px; background:var(--soft); } .card b { display:block; font-size:25px; color:var(--ink); } .card span { color:var(--muted); font-size:12px; }
    .status { display:inline-block; padding:5px 9px; border-radius:999px; color:#fff; background:var(--good); font-size:12px; font-weight:700; }
    .waiver { border-left:4px solid var(--warn); padding:12px 16px; background:#fffbeb; color:#713f12; }
    table { width:100%; border-collapse:collapse; margin:14px 0; } th,td { text-align:left; border-bottom:1px solid var(--line); padding:10px 9px; vertical-align:top; } th { color:var(--muted); font-size:12px; text-transform:uppercase; }
    code { background:#eef2ff; color:#3730a3; padding:2px 5px; border-radius:4px; overflow-wrap:anywhere; }
    footer { margin-top:34px; padding-top:18px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }
    @media (max-width:760px) { main { margin:0; border-radius:0; padding:24px; } .cards { grid-template-columns:repeat(2,1fr); } table { display:block; overflow-x:auto; } }
  </style>
</head>
<body><main>
  <div class="eyebrow">P2-06.5 · Gate A</div>
  <h1>Empirical Closeout</h1>
  <p>CanonicalTag v1 已收口；本页是便携式审计摘要，完整书目证据见同目录 JSON/CSV 与 Markdown 报告。</p>
  <div class="cards">
    <div class="card"><b>${canonical.tags.length}</b><span>CanonicalTag v1</span></div>
    <div class="card"><b>0</b><span>remaining merge reviews</span></div>
    <div class="card"><b>0</b><span>remaining low-value reviews</span></div>
    <div class="card"><b>FINAL</b><span>canonical status</span></div>
  </div>
  <p><span class="status">FINAL</span> <code>SHA-256 ${escapeHtml(canonicalSha)}</code></p>
  <div class="waiver"><strong>B1 remains PARTIAL.</strong> Owner waiver applies only to this run. Six 999ms intervals remain recorded; the global ≥1000ms start-spacing contract is unchanged.<ul>${timing}</ul></div>
  <h2>Closed decisions</h2>
  <table><thead><tr><th>ID</th><th>Source tags</th><th>Decision</th><th>Canonical target</th><th>Count effect</th></tr></thead><tbody>${rows}</tbody></table>
  <h2>Raw language resolution</h2>
  <p>19/20 仅保留 exact raw scope。字符形态只支持脚本方向推断，不足以证明 BCP-47 或地区；对应 C1 locale-specific statistics 明确阻断。</p>
  <table><thead><tr><th>Raw language</th><th>Final books</th><th>Distinct tokens</th><th>Resolution</th><th>C1 locale stats</th></tr></thead><tbody>${languageRows}</tbody></table>
  <h2>Boundary</h2>
  <p>B2 未运行；未修改数据库、schema、migration、生产 mapping、Worker/Scheduler、classifier 配置或业务代码。</p>
  <footer>Decision date ${DECISION_DATE} · Canonical version ${VERSION} · Evidence lineage and exact sample IDs are included in the companion artifacts.</footer>
</main></body></html>\n`;
}

async function assertMissing(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail(`output directory already exists: ${path}`);
}

async function main() {
  const paths = parseArguments(process.argv.slice(2));
  const tagCoveragePath = join(paths.aSourceDir, "tag-coverage.csv");
  const ownerDeltaPath = join(paths.aSourceDir, "owner-correction-incremental", "tag-coverage-delta.csv");
  const rawManifestPath = join(paths.b1RawDir, "raw-run-manifest.json");
  const derivedManifestPath = join(paths.b1DerivedDir, "lane-b-run-manifest.json");
  const finalKeysPath = join(paths.b1RawDir, "final-sample-book-keys.jsonl");
  const booksPath = join(paths.b1RawDir, "source-book-samples.jsonl");
  const requestAttemptsPath = join(paths.b1RawDir, "request-attempts.jsonl");

  const [tagCoverageBytes, ownerDeltaBytes, rawManifestBytes, derivedManifestBytes, finalKeysBytes, booksBytes, requestAttemptsBytes] = await Promise.all([
    readFile(tagCoveragePath),
    readFile(ownerDeltaPath),
    readFile(rawManifestPath),
    readFile(derivedManifestPath),
    readFile(finalKeysPath),
    readFile(booksPath),
    readFile(requestAttemptsPath),
  ]);

  const b1RawManifest = JSON.parse(rawManifestBytes.toString("utf8"));
  const b1DerivedManifest = JSON.parse(derivedManifestBytes.toString("utf8"));
  if (b1RawManifest.run_id !== RAW_RUN_ID || b1RawManifest.status !== "PARTIAL") fail("authoritative B1 run must remain the accepted PARTIAL v2 run");
  if (b1RawManifest.successful_pages !== 240 || b1RawManifest.actual_http_attempts !== 240 || b1RawManifest.retry_attempts !== 0) fail("B1 request facts do not match the Owner waiver");
  if (b1RawManifest.final_sample_books !== 10_000 || b1RawManifest.raw_round_trip_qa_passed !== true) fail("B1 sample/semantic facts do not match the Owner waiver");
  if (b1RawManifest.request_budget_qa_passed !== false) fail("B1 timing QA must remain failed");
  if (b1DerivedManifest.laneBSampleStatus !== "PARTIAL" || b1DerivedManifest.rawRoundTripQaPassed !== true) fail("derived B1 status does not preserve the accepted raw facts");

  const requestAttempts = parseJsonLines(requestAttemptsBytes.toString("utf8"), "request attempts");
  if (requestAttempts.length !== 240) fail(`expected 240 request attempts, found ${requestAttempts.length}`);
  const timingViolations = requestAttempts.slice(1).flatMap((attempt, index) => {
    const previous = requestAttempts[index];
    const interval = Date.parse(attempt.requestStartedAt) - Date.parse(previous.requestStartedAt);
    return interval < 1_000 ? [{
      previous_attempt: index + 1,
      next_attempt: index + 2,
      previous_started_at: previous.requestStartedAt,
      next_started_at: attempt.requestStartedAt,
      interval_ms: interval,
    }] : [];
  });
  if (timingViolations.length !== 6 || timingViolations.some((item) => item.interval_ms !== 999)) {
    fail(`Owner waiver requires exactly six preserved 999ms intervals, found ${JSON.stringify(timingViolations)}`);
  }

  const finalKeys = parseJsonLines(finalKeysBytes.toString("utf8"), "final sample keys");
  const selectedKeys = new Set(finalKeys.map((row) => row.sampleBookKey));
  if (selectedKeys.size !== 10_000 || selectedKeys.size !== finalKeys.length) fail("final sample must contain exactly 10,000 unique book identities");
  const finalBooks = parseJsonLines(booksBytes.toString("utf8"), "source books")
    .filter((book) => selectedKeys.has(book.sampleBookKey));
  if (finalBooks.length !== 10_000) fail(`expected 10,000 final books, found ${finalBooks.length}`);
  const bookById = new Map(finalBooks.map((book) => [book.externalBookIdRaw, book]));

  const baseRows = parseCsv(tagCoverageBytes.toString("utf8"));
  const deltaRows = parseCsv(ownerDeltaBytes.toString("utf8"));
  if (baseRows.length !== 151) fail(`expected 151 original A source tags, found ${baseRows.length}`);
  const correctedRows = overlayOwnerCorrection(baseRows, deltaRows);
  const correctedCount = new Set(correctedRows
    .filter((row) => !new Set(["DROP_RECOMMENDED", "DECOMPOSE_TO_ATOMS"]).has(row.final_disposition))
    .map((row) => row.final_slug)).size;
  if (correctedCount !== EXPECTED_BASELINE_COUNT) fail(`expected corrected baseline ${EXPECTED_BASELINE_COUNT}, found ${correctedCount}`);
  const closedRows = applyEmpiricalCloseout(correctedRows);
  const canonical = buildCanonicalArtifact(closedRows);
  const canonicalBytes = Buffer.from(`${JSON.stringify(canonical, null, 2)}\n`, "utf8");
  const canonicalSha = sha256(canonicalBytes);
  const evidence = buildDecisionEvidence(finalBooks, bookById);
  const languages = [languageResolution(finalBooks, 19), languageResolution(finalBooks, 20)];
  const sources = {
    tag_coverage_sha256: sha256(tagCoverageBytes),
    owner_correction_delta_sha256: sha256(ownerDeltaBytes),
    b1_raw_manifest_sha256: sha256(rawManifestBytes),
    b1_derived_manifest_sha256: sha256(derivedManifestBytes),
    final_sample_keys_sha256: sha256(finalKeysBytes),
    source_book_samples_sha256: sha256(booksBytes),
    request_attempts_sha256: sha256(requestAttemptsBytes),
  };
  if (b1DerivedManifest.rawManifestSha256 !== sources.b1_raw_manifest_sha256) fail("B1 derived manifest is not bound to the authoritative raw manifest bytes");

  const decisions = {
    schema_version: 1,
    decision_date: DECISION_DATE,
    owner_principle: "CanonicalTag is a user retrieval entry, not a literary knowledge graph. Prefer MERGE + ALIAS when the combined result set would not feel materially wrong.",
    prior_candidate_count: EXPECTED_BASELINE_COUNT,
    final_candidate_count: canonical.tags.length,
    remaining_merge_reviews: 0,
    remaining_low_value_reviews: 0,
    b1_run_acceptability: "ACCEPT_WITH_TIMING_WAIVER",
    sampling_decision: "10K_SUFFICIENT",
    authoritative_b1_status: "PARTIAL",
    global_request_spacing_contract_ms: 1000,
    timing_waiver_scope: "SINGLE_RUN_ONLY",
    timing_violations: timingViolations,
    ...evidence,
  };
  const languageArtifact = {
    schema_version: 1,
    decision_date: DECISION_DATE,
    resolution_policy: "Do not infer a canonical locale from script, title, description, or null languageName. Retain exact raw scope until exact upstream evidence or an Owner-approved registry exists.",
    languages,
  };
  const report = renderReport({ canonical, canonicalSha, evidence, languages, sources, b1RawManifest, b1DerivedManifest, timingViolations });
  const htmlReport = renderHtmlReport({ canonical, canonicalSha, evidence, languages, timingViolations });
  const decisionCsv = rowsToCsv([
    "decision_id",
    "source_tags",
    "final_decision",
    "canonical_targets",
    "aliases",
    "count_effect",
    "evidence_metrics_json",
    "sample_book_ids",
    "rationale",
  ], decisionRows(evidence));

  const files = new Map([
    ["canonical-tag-v1.0.0.json", canonicalBytes],
    ["canonical-tag-v1.0.0.json.sha256", Buffer.from(`${canonicalSha}  canonical-tag-v1.0.0.json\n`, "utf8")],
    ["a-empirical-closeout-decisions.json", Buffer.from(`${JSON.stringify(decisions, null, 2)}\n`, "utf8")],
    ["a-empirical-closeout-decisions.csv", Buffer.from(decisionCsv, "utf8")],
    ["raw-language-resolution.json", Buffer.from(`${JSON.stringify(languageArtifact, null, 2)}\n`, "utf8")],
    ["A_EMPIRICAL_CLOSEOUT.md", Buffer.from(report, "utf8")],
    ["A_EMPIRICAL_CLOSEOUT.html", Buffer.from(htmlReport, "utf8")],
  ]);
  const manifest = {
    schema_version: 1,
    closeout_version: VERSION,
    decision_date: DECISION_DATE,
    canonical_version: canonical.canonical_version,
    canonical_tag_count: canonical.tags.length,
    canonical_artifact_sha256: canonicalSha,
    canonical_status: "FINAL",
    b2_executed: false,
    authoritative_b1_status: "PARTIAL",
    timing_waiver_scope: "SINGLE_RUN_ONLY",
    timing_violation_count: timingViolations.length,
    timing_violation_intervals_ms: timingViolations.map((item) => item.interval_ms),
    sources,
    artifacts: [...files.entries()].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })),
  };
  files.set("a-closeout-manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));

  await assertMissing(paths.outputDir);
  await mkdir(dirname(paths.outputDir), { recursive: true });
  const staging = await mkdtemp(join(dirname(paths.outputDir), `.${basename(paths.outputDir)}-staging-`));
  try {
    for (const [name, bytes] of files) await writeFile(join(staging, name), bytes, { flag: "wx", mode: 0o644 });
    await rename(staging, paths.outputDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  process.stdout.write(`${JSON.stringify({
    output_dir: paths.outputDir,
    canonical_version: canonical.canonical_version,
    canonical_tag_count: canonical.tags.length,
    canonical_sha256: canonicalSha,
    remaining_merge_reviews: 0,
    remaining_low_value_reviews: 0,
    canonical_status: "FINAL",
    b2_executed: false,
  }, null, 2)}\n`);
}

await main();
