#!/usr/bin/env node
// P1-06 复核（第二轮）：约束比对改成"按类型比对 + CHECK 归一化"。
//
// 背景：pg_dump --format=custom 走自定义压缩格式，pg_restore 用同一份归档
// 重建约束时，PostgreSQL 对 CHECK 约束里 `x = ANY (ARRAY[...])` 这类表达式
// 的类型转换位置渲染不稳定——同一条语义完全等价的约束，在"刚被迁移建出来
// 的源库"和"从它的逻辑备份 pg_restore 出来的库"上，pg_get_constraintdef()
// 吐出来的文本可能不是逐字相同（例如整体转型 `(ARRAY[...])::text[]`
// vs 逐元素转型 `ARRAY[(...)::text, ...]`）。这是已知、良性的 Postgres
// 渲染差异，不代表约束的值域/语义变了。
//
// 主控裁决（第二轮）：非 CHECK 约束（p/f/u/x）继续逐字比对
// （conname、所属表、contype、pg_get_constraintdef 全等）；CHECK 约束
// （contype=c）只在 conname 和所属表全等的前提下，把表达式做归一化再比：
// 归一化只允许去掉 `::character varying`、`::text[]`、`::text` 这三种类型
// 转换、所有圆括号、所有空白——不许动其它任何字符（含引号、逗号、方括号、
// 大小写、关键字本身）。列类型漂移由 check-database-dictionary-drift.mjs
// 覆盖，不在这份约束摘要的职责内。
import { PrismaClient } from "@prisma/client";

const sourceUrl = process.env.P1_06_CONSTRAINT_SOURCE_URL;
const restoreUrl = process.env.P1_06_CONSTRAINT_RESTORE_URL;
if (!sourceUrl || !restoreUrl) {
  throw new Error(
    "P1_06_CONSTRAINT_SOURCE_URL and P1_06_CONSTRAINT_RESTORE_URL are both required",
  );
}

const CONSTRAINT_QUERY = `
  SELECT c.conname AS name, r.relname AS table_name, c.contype AS type,
         pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE n.nspname = 'public'
  ORDER BY c.conname
`;

// 顺序要紧：`::text[]` 必须先于 `::text` 处理，否则 `ARRAY[...]::text[]`
// 会被 `::text` 先吃掉一段，留下多余的 `[]`。
function normalizeCheckDef(def) {
  return def
    .replaceAll("::character varying", "")
    .replaceAll("::text[]", "")
    .replaceAll("::text", "")
    .replaceAll("(", "")
    .replaceAll(")", "")
    .replace(/\s+/g, "");
}

async function fetchConstraints(url) {
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    return await prisma.$queryRawUnsafe(CONSTRAINT_QUERY);
  } finally {
    await prisma.$disconnect();
  }
}

const [sourceRows, restoreRows] = await Promise.all([
  fetchConstraints(sourceUrl),
  fetchConstraints(restoreUrl),
]);

const sourceByName = new Map(sourceRows.map((row) => [row.name, row]));
const restoreByName = new Map(restoreRows.map((row) => [row.name, row]));
const allNames = [...new Set([...sourceByName.keys(), ...restoreByName.keys()])].sort();

const problems = [];
const rawDiffPairs = [];
const normalizedEvidence = [];

for (const name of allNames) {
  const source = sourceByName.get(name);
  const restore = restoreByName.get(name);
  if (!source) {
    problems.push(`constraint ${name} present only in restore (table ${restore.table_name})`);
    continue;
  }
  if (!restore) {
    problems.push(`constraint ${name} present only in source (table ${source.table_name})`);
    continue;
  }
  if (source.table_name !== restore.table_name || source.type !== restore.type) {
    problems.push(
      `constraint ${name} table/type mismatch: source=${source.table_name}/${source.type} restore=${restore.table_name}/${restore.type}`,
    );
    continue;
  }
  if (source.type === "c") {
    const sourceNorm = normalizeCheckDef(source.def);
    const restoreNorm = normalizeCheckDef(restore.def);
    if (sourceNorm !== restoreNorm) {
      problems.push(
        `CHECK constraint ${name} (table ${source.table_name}) differs after normalization:\n  source:     ${source.def}\n  restore:    ${restore.def}\n  source-norm:  ${sourceNorm}\n  restore-norm: ${restoreNorm}`,
      );
    } else if (source.def !== restore.def) {
      rawDiffPairs.push({ name, table: source.table_name, source: source.def, restore: restore.def });
      normalizedEvidence.push({ name, normalized: sourceNorm });
    }
  } else if (source.def !== restore.def) {
    problems.push(
      `${source.type} constraint ${name} (table ${source.table_name}) verbatim mismatch:\n  source:  ${source.def}\n  restore: ${restore.def}`,
    );
  }
}

if (process.argv.includes("--show-benign-check-diffs") && rawDiffPairs.length) {
  console.log(
    `${rawDiffPairs.length} CHECK constraint(s) differ verbatim but are identical after normalization:`,
  );
  for (const pair of rawDiffPairs) {
    console.log(`-- ${pair.name} (${pair.table})`);
    console.log(`source:  ${pair.source}`);
    console.log(`restore: ${pair.restore}`);
  }
  console.log("normalized (both sides equal):");
  for (const item of normalizedEvidence) {
    console.log(`-- ${item.name}: ${item.normalized}`);
  }
}

if (problems.length) {
  console.error(problems.join("\n\n"));
  process.exit(1);
}

console.log(
  JSON.stringify({
    status: "ok",
    constraintCount: allNames.length,
    benignCheckTextDiffCount: rawDiffPairs.length,
  }),
);
