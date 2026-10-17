#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "prisma/schema.prisma");
const dictionaryPath = path.join(
  root,
  "docs/governance/database-schema-dictionary.jsonl",
);
const staticOnly = process.argv.includes("--static");

/**
 * The ONLY SECURITY DEFINER functions the database may contain, keyed by function name. Shared by the static check
 * (the dictionary record of a registered DEFINER function must match its entry) and the live-catalog check (any
 * `prosecdef = true` function in a non-system schema that is not listed here fails the check, registered in the
 * dictionary or not). Adding another DEFINER function therefore means editing this list on purpose, in the same
 * change that adds the migration (v0.6.0 Owner 2026-10-14: database-level tightening of upstream_code).
 */
export const ALLOWED_DEFINER_FUNCTIONS = new Map([
  ["code_mode_upstream_code", { schema: "public", identityArguments: "p_public_redirect_code text", returnType: "text" }],
]);

function fail(messages) {
  const problems = Array.isArray(messages) ? messages : [messages];
  throw new Error(`Database dictionary drift:\n- ${problems.join("\n- ")}`);
}

function physicalTableName(modelBody, modelName) {
  return modelBody.match(/@@map\("([^"]+)"\)/)?.[1] ?? modelName;
}

function parseSchema(schema) {
  const tables = new Map();
  const modelPattern = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  for (const match of schema.matchAll(modelPattern)) {
    const [, modelName, body] = match;
    const tableName = physicalTableName(body, modelName);
    const fields = new Set();
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
      const field = line.match(/^(\w+)\s+([^\s]+)/);
      if (!field) continue;
      const [, logicalName, prismaType] = field;
      const baseType = prismaType.replace(/[?\[\]]/g, "");
      const scalarTypes = new Set([
        "String",
        "Int",
        "BigInt",
        "Boolean",
        "DateTime",
        "Decimal",
        "Json",
        "Bytes",
        "Float",
      ]);
      if (!scalarTypes.has(baseType)) continue;
      const mappedName = line.match(/@map\("([^"]+)"\)/)?.[1] ?? logicalName;
      fields.add(mappedName);
    }
    tables.set(tableName, fields);
  }
  return tables;
}

function parseDictionary(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
      }
    });
}

/**
 * @param {Map<string, Set<string>>} schemaTables
 * @param {Array<Record<string, any>>} records
 * @param {{ allowedDefinerFunctions?: Map<string, { schema: string, identityArguments: string, returnType: string }> }} [options]
 */
export function assertStaticConsistency(schemaTables, records, { allowedDefinerFunctions = ALLOWED_DEFINER_FUNCTIONS } = {}) {
  const problems = [];
  const keys = new Set();
  for (const record of records) {
    if (keys.has(record.stable_key)) {
      problems.push(`duplicate stable_key ${record.stable_key}`);
    }
    keys.add(record.stable_key);
  }

  const active = records.filter((record) => record.status === "active");
  const tableRecords = new Set(
    active
      .filter((record) => record.record_kind === "table")
      .map((record) => record.table_name),
  );
  const fieldRecords = new Set(
    active
      .filter((record) => record.record_kind === "field")
      .map((record) => `${record.table_name}.${record.field_name}`),
  );

  for (const [tableName, fields] of schemaTables) {
    if (!tableRecords.has(tableName)) problems.push(`orphan Schema table ${tableName}`);
    for (const fieldName of fields) {
      if (!fieldRecords.has(`${tableName}.${fieldName}`)) {
        problems.push(`orphan Schema field ${tableName}.${fieldName}`);
      }
    }
  }

  for (const record of active) {
    if (record.record_kind === "table" && !schemaTables.has(record.table_name)) {
      problems.push(`ghost dictionary table ${record.table_name}`);
    }
    if (
      record.record_kind === "field" &&
      !schemaTables.get(record.table_name)?.has(record.field_name)
    ) {
      problems.push(`ghost dictionary field ${record.table_name}.${record.field_name}`);
    }
    if (
      record.record_kind === "constraint" &&
      record.managed_by !== "application_contract" &&
      !record.physical_name
    ) {
      problems.push(`database object without physical_name ${record.stable_key}`);
    }
  }

  // Registered functions are of exactly two kinds: zero-argument SECURITY INVOKER trigger functions, and the
  // explicitly allow-listed SECURITY DEFINER functions (ALLOWED_DEFINER_FUNCTIONS, module level, shared with the
  // live-catalog check below).
  for (const record of active.filter((item) => item.data_type === "function")) {
    const common = record.record_kind === "constraint" && record.managed_by === "migration_sql"
      && record.function_schema === "public";
    const triggerFunction = common && record.function_identity_arguments === ""
      && record.function_return_type === "trigger" && record.function_security === "invoker";
    const allowed = allowedDefinerFunctions.get(record.physical_name);
    const definerFunction = common && allowed !== undefined
      && record.function_schema === allowed.schema
      && record.function_identity_arguments === allowed.identityArguments
      && record.function_return_type === allowed.returnType && record.function_security === "definer";
    if (!triggerFunction && !definerFunction) {
      problems.push(`invalid registered function contract ${record.stable_key}`);
    }
  }

  // C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.1): three new
  // models (ArticleNovelRebindPreview/Batch/BatchItem) push the count from
  // 49 to 52 -- updated alongside the migration that adds them, same as the
  // 51->49 update Phase C's C-4 DROP made when it removed two models.
  // Owner 2026-09-18 决策 2: ChannelAccountHold
  // (20260918090000_preview_account_hold) pushes 52 -> 53.
  // 收益看板·账号级每日汇总 (20261008120000_revenue_account_level_dashboard) adds
  // revenue_sync_scope / revenue_sync_batch / revenue_raw_snapshot / revenue_daily_stat,
  // pushing 53 -> 57.
  // B-38 (20261009120000_b38_novel_effective_tag) adds novel_effective_tag: 57 -> 58.
  // v0.6.2 收益看板按书 / 国家 (20261017120000_revenue_book_country_breakdown) adds
  // revenue_book_daily_stat / revenue_country_daily_stat: 58 -> 60.
  if (schemaTables.size !== 60) {
    problems.push(`expected 60 Prisma models, found ${schemaTables.size}`);
  }
  if (problems.length) fail(problems);
  return { recordCount: records.length, activeCount: active.length };
}

/**
 * @param {Array<Record<string, any>>} records parsed dictionary records
 * @param {{
 *   prisma?: import("@prisma/client").PrismaClient,
 *   allowedDefinerFunctions?: Map<string, { schema: string, identityArguments: string, returnType: string }>,
 * }} [options] `prisma`: reuse a client (tests); default opens one from DATABASE_URL and closes it afterwards.
 */
export async function assertCatalogConsistency(
  records,
  { prisma: injectedPrisma, allowedDefinerFunctions = ALLOWED_DEFINER_FUNCTIONS } = {},
) {
  const prisma = injectedPrisma ?? new PrismaClient();
  try {
    const [tables, columns, constraints, indexes, triggers, functions] = await Promise.all([
      prisma.$queryRawUnsafe(`
        SELECT tablename AS name
        FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
      `),
      prisma.$queryRawUnsafe(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
      `),
      prisma.$queryRawUnsafe(`
        SELECT c.conname AS name
        FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE n.nspname = 'public' AND r.relname <> '_prisma_migrations'
      `),
      prisma.$queryRawUnsafe(`
        SELECT indexname AS name
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
      `),
      prisma.$queryRawUnsafe(`
        SELECT t.tgname AS name
        FROM pg_trigger t
        JOIN pg_class r ON r.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal
      `),
      // Every function / procedure / aggregate / window function in a NON-SYSTEM schema, except objects owned by an
      // extension (pg_depend deptype 'e'). Not just `prokind = 'f'` in `public`: a SECURITY DEFINER procedure, or a
      // function created in some other schema, must not be invisible to this check.
      prisma.$queryRawUnsafe(`
        SELECT n.nspname AS schema_name, p.proname AS name,
               pg_get_function_identity_arguments(p.oid) AS identity_arguments,
               format_type(p.prorettype, NULL) AS return_type,
               p.prosecdef AS security_definer,
               p.prokind::text AS kind
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
          AND p.prokind IN ('f', 'p', 'a', 'w')
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
            WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
          )
      `),
    ]);

    const actualTables = new Set(tables.map(({ name }) => name));
    const actualColumns = new Set(
      columns.map(({ table_name, column_name }) => `${table_name}.${column_name}`),
    );
    const actualConstraints = new Set(constraints.map(({ name }) => name));
    const actualIndexes = new Set(indexes.map(({ name }) => name));
    const actualTriggers = new Set(triggers.map(({ name }) => name));
    const expectedPhysical = new Set();
    const problems = [];

    for (const record of records.filter((item) => item.status === "active")) {
      if (record.record_kind === "table" && !actualTables.has(record.table_name)) {
        problems.push(`dictionary table missing from database ${record.table_name}`);
      }
      if (
        record.record_kind === "field" &&
        !actualColumns.has(`${record.table_name}.${record.field_name}`)
      ) {
        problems.push(`dictionary field missing from database ${record.table_name}.${record.field_name}`);
      }
      if (record.record_kind !== "constraint" || record.managed_by === "application_contract") {
        continue;
      }
      if (record.data_type === "function") {
        const fn = functions.find((candidate) =>
          candidate.schema_name === record.function_schema
          && candidate.name === record.physical_name
          && candidate.identity_arguments === record.function_identity_arguments);
        if (!fn || fn.return_type !== record.function_return_type
          || fn.security_definer !== (record.function_security === "definer")) {
          problems.push(`dictionary function missing or incompatible ${record.physical_name}`);
        }
        continue;
      }
      expectedPhysical.add(record.physical_name);
      const type = record.data_type;
      const exists =
        type === "trigger" || type === "permission_trigger"
          ? actualTriggers.has(record.physical_name)
          : type.includes("index") || type === "unique" || type === "unique_retention"
            ? actualIndexes.has(record.physical_name)
            : actualConstraints.has(record.physical_name) || actualIndexes.has(record.physical_name);
      if (!exists) problems.push(`dictionary database object missing ${record.physical_name}`);
    }

    for (const name of [...actualConstraints, ...actualIndexes, ...actualTriggers]) {
      if (!expectedPhysical.has(name)) problems.push(`database object missing from dictionary ${name}`);
    }

    // Hard rule, independent of the dictionary: a SECURITY DEFINER function runs with its owner's privileges, so the
    // set of them is an explicit allow-list. Any `prosecdef = true` function that is not on it fails the check,
    // whether or not somebody remembered to register it.
    const functionLabel = (fn) => `${fn.schema_name}.${fn.name}(${fn.identity_arguments})`;
    for (const fn of functions.filter((candidate) => candidate.security_definer)) {
      const allowed = allowedDefinerFunctions.get(fn.name);
      if (
        !allowed || allowed.schema !== fn.schema_name || allowed.identityArguments !== fn.identity_arguments
        || allowed.returnType !== fn.return_type
      ) {
        problems.push(`SECURITY DEFINER function is not on the allow-list ${functionLabel(fn)}`);
      }
    }

    // Reverse check for functions: every live function (non-system schema, not extension-owned) must have an active
    // dictionary record with the same schema, name and identity arguments -- same discipline as constraints/indexes.
    const registeredFunctions = new Set(
      records
        .filter((item) => item.status === "active" && item.record_kind === "constraint" && item.data_type === "function"
          && item.managed_by !== "application_contract")
        .map((item) => `${item.function_schema}.${item.physical_name}(${item.function_identity_arguments})`),
    );
    for (const fn of functions) {
      if (!registeredFunctions.has(functionLabel(fn))) {
        problems.push(`database function missing from dictionary ${functionLabel(fn)}`);
      }
    }
    // C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.1): three new
    // rebind tables (article_novel_rebind_preview/_batch/_batch_item) push the
    // live-catalog baseline from 49 to 52, mirroring the 52-model constant
    // assertStaticConsistency already carries above. Owner 2026-09-18 决策 2:
    // channel_account_hold pushes it to 53. 收益看板 (20261008120000_revenue_account_level_dashboard)
    // adds four revenue_* tables: 53 -> 57. B-38 (20261009120000_b38_novel_effective_tag)
    // adds novel_effective_tag: 57 -> 58. v0.6.2 (20261017120000_revenue_book_country_breakdown)
    // adds revenue_book_daily_stat / revenue_country_daily_stat: 58 -> 60.
    if (actualTables.size !== 60) problems.push(`expected 60 database tables, found ${actualTables.size}`);
    if (problems.length) fail(problems);
    return {
      tableCount: actualTables.size,
      constraintCount: actualConstraints.size,
      indexCount: actualIndexes.size,
      triggerCount: actualTriggers.size,
    };
  } finally {
    if (!injectedPrisma) await prisma.$disconnect();
  }
}

export async function loadRepoDictionary() {
  const [schema, dictionaryText] = await Promise.all([
    readFile(schemaPath, "utf8"),
    readFile(dictionaryPath, "utf8"),
  ]);
  return { schemaTables: parseSchema(schema), records: parseDictionary(dictionaryText) };
}

async function main() {
  const { schemaTables, records } = await loadRepoDictionary();
  const staticResult = assertStaticConsistency(schemaTables, records);
  const catalogResult = staticOnly ? null : await assertCatalogConsistency(records);

  process.stdout.write(
    `${JSON.stringify({ status: "ok", models: schemaTables.size, ...staticResult, ...catalogResult })}\n`,
  );
}

// Run as a script (`node scripts/check-database-dictionary-drift.mjs [--static]`); importing it (tests) does not run it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
