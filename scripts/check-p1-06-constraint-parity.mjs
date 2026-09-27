#!/usr/bin/env node
// P1-06 复核：约束 + 索引/触发器比对，都是"按类型比对 + 局部归一化"
// （第二轮先落地约束，第三轮主控授权把同款方法扩到索引谓词）。
//
// 背景：pg_dump --format=custom 走自定义压缩格式，pg_restore 用同一份归档
// 重建对象时，PostgreSQL 对 `x = ANY (ARRAY[...])` 这类表达式的类型转换
// 位置渲染不稳定——同一条语义完全等价的表达式，在"刚被迁移建出来的源库"
// 和"从它的逻辑备份 pg_restore 出来的库"上，deparse 出来的文本可能不是
// 逐字相同（例如整体转型 `(ARRAY[...])::text[]` vs 逐元素转型
// `ARRAY[(...)::text, ...]`）。这是已知、良性的 Postgres 渲染差异，不代表
// 值域/语义变了。实测这个差异只出现在“由 IN (...) 列表转换来的
// = ANY (ARRAY[...])”这一种表达式形状里，会出现在 CHECK 约束的表达式和
// 部分索引（partial index）的 WHERE 谓词两个地方，两处 deparse 走的是同一
// 套 ruleutils 逻辑。
//
// ── 约束（第二轮主控裁决）──────────────────────────────────────────────
// 非 CHECK 约束（p/f/u/x）逐字比对（conname、所属表、contype、
// pg_get_constraintdef 全等）；CHECK 约束（contype=c）只在 conname 和所属
// 表全等的前提下，把表达式做归一化再比。
//
// ── 索引/触发器（第三轮主控裁决）────────────────────────────────────────
// 触发器定义、普通索引（无 WHERE）定义：逐字比对。
// 部分索引（indexdef 里带 WHERE 子句的）：WHERE 之前的部分（索引名、表、
// 列、唯一性、方法）逐字比对；只有 WHERE 谓词这一段套用跟 CHECK 完全相同
// 的归一化规则。
//
// ── 归一化规则（两处共用，不许再宽）────────────────────────────────────
// 只允许去掉 `::character varying`、`::text[]`、`::text` 这三种类型转换、
// 所有圆括号、所有空白——不许动其它任何字符（含引号、逗号、方括号、大小
// 写、关键字本身）。列类型漂移由 check-database-dictionary-drift.mjs 覆
// 盖，不在这份摘要的职责内。
import { createHash } from "node:crypto";

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

const INDEX_QUERY = `
  SELECT indexname AS name, tablename AS table_name, indexdef AS def
  FROM pg_indexes
  WHERE schemaname = 'public'
  ORDER BY indexname
`;

const TRIGGER_QUERY = `
  SELECT t.tgname AS name, c.relname AS table_name, pg_get_triggerdef(t.oid) AS def
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal
  ORDER BY t.tgname
`;

// 顺序要紧：`::text[]` 必须先于 `::text` 处理，否则 `ARRAY[...]::text[]`
// 会被 `::text` 先吃掉一段，留下多余的 `[]`。
function normalizeExpression(expr) {
  return expr
    .replaceAll("::character varying", "")
    .replaceAll("::text[]", "")
    .replaceAll("::text", "")
    .replaceAll("(", "")
    .replaceAll(")", "")
    .replace(/\s+/g, "");
}

// Postgres 的 pg_get_indexdef() 用大写、两侧带空格的字面量 ` WHERE ` 作为
// 部分索引谓词的分隔符，且只会出现这一次；普通索引不含这个子串。
function splitIndexDef(def) {
  const marker = " WHERE ";
  const at = def.indexOf(marker);
  if (at === -1) return { prefix: def, predicate: null };
  return { prefix: def.slice(0, at), predicate: def.slice(at + marker.length) };
}

async function fetchRows(url, query) {
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    return await prisma.$queryRawUnsafe(query);
  } finally {
    await prisma.$disconnect();
  }
}

async function fetchAll(url) {
  const [constraints, indexes, triggers] = await Promise.all([
    fetchRows(url, CONSTRAINT_QUERY),
    fetchRows(url, INDEX_QUERY),
    fetchRows(url, TRIGGER_QUERY),
  ]);
  return { constraints, indexes, triggers };
}

const [source, restore] = await Promise.all([fetchAll(sourceUrl), fetchAll(restoreUrl)]);

const problems = [];
const benignCheckDiffs = [];
const benignIndexDiffs = [];

function compareByName(kind, sourceRows, restoreRows, compareOne) {
  const sourceByName = new Map(sourceRows.map((row) => [row.name, row]));
  const restoreByName = new Map(restoreRows.map((row) => [row.name, row]));
  const allNames = [...new Set([...sourceByName.keys(), ...restoreByName.keys()])].sort();
  for (const name of allNames) {
    const s = sourceByName.get(name);
    const r = restoreByName.get(name);
    if (!s) {
      problems.push(`${kind} ${name} present only in restore (table ${r.table_name})`);
      continue;
    }
    if (!r) {
      problems.push(`${kind} ${name} present only in source (table ${s.table_name})`);
      continue;
    }
    if (s.table_name !== r.table_name) {
      problems.push(`${kind} ${name} table mismatch: source=${s.table_name} restore=${r.table_name}`);
      continue;
    }
    compareOne(name, s, r);
  }
  return allNames;
}

// ── 约束 ──────────────────────────────────────────────────────────────
const constraintNames = compareByName("constraint", source.constraints, restore.constraints, (name, s, r) => {
  if (s.type !== r.type) {
    problems.push(`constraint ${name} type mismatch: source=${s.type} restore=${r.type}`);
    return;
  }
  if (s.type === "c") {
    const sNorm = normalizeExpression(s.def);
    const rNorm = normalizeExpression(r.def);
    if (sNorm !== rNorm) {
      problems.push(
        `CHECK constraint ${name} (table ${s.table_name}) differs after normalization:\n  source:     ${s.def}\n  restore:    ${r.def}\n  source-norm:  ${sNorm}\n  restore-norm: ${rNorm}`,
      );
    } else if (s.def !== r.def) {
      benignCheckDiffs.push({ name, table: s.table_name, source: s.def, restore: r.def, normalized: sNorm });
    }
  } else if (s.def !== r.def) {
    problems.push(
      `${s.type} constraint ${name} (table ${s.table_name}) verbatim mismatch:\n  source:  ${s.def}\n  restore: ${r.def}`,
    );
  }
});

// ── 索引 ──────────────────────────────────────────────────────────────
const indexNames = compareByName("index", source.indexes, restore.indexes, (name, s, r) => {
  const sSplit = splitIndexDef(s.def);
  const rSplit = splitIndexDef(r.def);
  if (sSplit.prefix !== rSplit.prefix) {
    problems.push(
      `index ${name} (table ${s.table_name}) prefix mismatch (name/table/columns/uniqueness/method):\n  source:  ${s.def}\n  restore: ${r.def}`,
    );
    return;
  }
  if ((sSplit.predicate === null) !== (rSplit.predicate === null)) {
    problems.push(
      `index ${name} (table ${s.table_name}) partial-index-ness mismatch:\n  source:  ${s.def}\n  restore: ${r.def}`,
    );
    return;
  }
  if (sSplit.predicate === null) {
    // 普通索引：前面已经确认前缀（也就是整条定义）逐字相同，没别的可比了。
    return;
  }
  const sNorm = normalizeExpression(sSplit.predicate);
  const rNorm = normalizeExpression(rSplit.predicate);
  if (sNorm !== rNorm) {
    problems.push(
      `partial index ${name} (table ${s.table_name}) WHERE predicate differs after normalization:\n  source:     ${s.def}\n  restore:    ${r.def}\n  source-norm:  ${sNorm}\n  restore-norm: ${rNorm}`,
    );
  } else if (s.def !== r.def) {
    benignIndexDiffs.push({ name, table: s.table_name, source: s.def, restore: r.def, normalized: `${sSplit.prefix} WHERE ${sNorm}` });
  }
});

// ── 触发器：全程逐字比对 ──────────────────────────────────────────────
const triggerNames = compareByName("trigger", source.triggers, restore.triggers, (name, s, r) => {
  if (s.def !== r.def) {
    problems.push(
      `trigger ${name} (table ${s.table_name}) verbatim mismatch:\n  source:  ${s.def}\n  restore: ${r.def}`,
    );
  }
});

if (process.argv.includes("--show-benign-check-diffs") && benignCheckDiffs.length) {
  console.log(
    `${benignCheckDiffs.length} CHECK constraint(s) differ verbatim but are identical after normalization:`,
  );
  for (const pair of benignCheckDiffs) {
    console.log(`-- ${pair.name} (${pair.table})`);
    console.log(`source:  ${pair.source}`);
    console.log(`restore: ${pair.restore}`);
  }
  console.log("normalized (both sides equal):");
  for (const item of benignCheckDiffs) {
    console.log(`-- ${item.name}: ${item.normalized}`);
  }
}

if (process.argv.includes("--show-benign-index-diffs") && benignIndexDiffs.length) {
  console.log(
    `${benignIndexDiffs.length} partial index(es) differ verbatim but are identical after WHERE-predicate normalization:`,
  );
  for (const pair of benignIndexDiffs) {
    console.log(`-- ${pair.name} (${pair.table})`);
    console.log(`source:  ${pair.source}`);
    console.log(`restore: ${pair.restore}`);
  }
}

if (problems.length) {
  console.error(problems.join("\n\n"));
  process.exit(1);
}

// 两边此时已确认在"按类型比对 + 归一化"意义下相等，用 restore 侧算一份
// 摘要留痕（跟原来 md5(string_agg(...)) 的做法一脉相承，只是逐字改成了
// 归一化后的文本，这样良性渲染差异不会导致同一份数据在不同环境算出两个
// 不同的摘要）。
function digestOf(rows, pick) {
  const lines = rows.map(pick).sort();
  return createHash("md5").update(lines.join("\n")).digest("hex");
}
const constraintDigest = digestOf(restore.constraints, (row) => {
  const norm = row.type === "c" ? normalizeExpression(row.def) : row.def;
  return `${row.name}|${row.table_name}|${row.type}|${norm}`;
});
const objectDigest = digestOf(
  [
    ...restore.indexes.map((row) => {
      const split = splitIndexDef(row.def);
      const norm = split.predicate === null ? split.prefix : `${split.prefix} WHERE ${normalizeExpression(split.predicate)}`;
      return `index|${row.name}|${norm}`;
    }),
    ...restore.triggers.map((row) => `trigger|${row.name}|${row.def}`),
  ],
  (line) => line,
);

console.log(
  JSON.stringify({
    status: "ok",
    constraintCount: constraintNames.length,
    indexCount: indexNames.length,
    triggerCount: triggerNames.length,
    benignCheckTextDiffCount: benignCheckDiffs.length,
    benignIndexTextDiffCount: benignIndexDiffs.length,
    constraintDigest,
    objectDigest,
  }),
);
